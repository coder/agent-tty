import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { writeTextFileAtomic } from '../../src/storage/manifests.js';
import { assertString, invariant } from '../../src/util/assert.js';
import { validatePathSegment } from '../lib/artifacts.js';
import {
  buildSnapshotLogicalKey,
  SnapshotEntrySchema,
} from './schema.js';
import type { SnapshotEntry } from './schema.js';

interface NodeError {
  code?: string;
}

export interface SnapshotLoadDiagnostic {
  kind: 'malformed' | 'stale';
  path: string;
  lineNumber: number;
  message: string;
}

export interface LoadSnapshotFileOptions {
  snapshotDir: string;
  provider: string;
  model: string;
  validCurrentKeys?: ReadonlySet<string>;
  allowMissing?: boolean;
}

export interface WriteSnapshotFileOptions {
  snapshotDir: string;
  provider: string;
  model: string;
  entries: readonly SnapshotEntry[];
}

const SnapshotEntryArraySchema = SnapshotEntrySchema.array();

function isEnoentError(error: unknown): error is Error & NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeError).code === 'ENOENT'
  );
}

function resolveSnapshotDir(snapshotDir: string): string {
  assertString(snapshotDir, 'snapshotDir must be a string');
  invariant(snapshotDir.length > 0, 'snapshotDir must be a non-empty string');

  const resolvedSnapshotDir = resolve(snapshotDir);
  invariant(isAbsolute(resolvedSnapshotDir), 'snapshotDir must resolve to absolute');

  return resolvedSnapshotDir;
}

function assertPathInsideBase(
  baseDir: string,
  candidatePath: string,
  label: string,
): string {
  const normalizedBaseDir = resolve(baseDir);
  const normalizedCandidatePath = resolve(candidatePath);
  const relativePath = relative(normalizedBaseDir, normalizedCandidatePath);

  invariant(
    relativePath === '' ||
      (!relativePath.startsWith('..') && !isAbsolute(relativePath)),
    `${label} must stay within base directory ${normalizedBaseDir}`,
  );

  return normalizedCandidatePath;
}

function warnSkippedSnapshotEntry(
  path: string,
  lineNumber: number,
  message: string,
): void {
  console.warn(
    `[evals] Skipping snapshot entry at ${path}:${String(lineNumber)}: ${message}`,
  );
}

function buildSnapshotEntryKey(entry: SnapshotEntry): string {
  return buildSnapshotLogicalKey({
    lane: entry.lane,
    caseId: entry.caseId,
    condition: entry.condition,
    caseFingerprint: entry.caseFingerprint,
  });
}

function assertEntryMatchesFile(
  entry: SnapshotEntry,
  provider: string,
  model: string,
): void {
  invariant(
    entry.provider === provider,
    `Snapshot entry provider mismatch: expected ${provider}, got ${entry.provider}`,
  );
  invariant(
    entry.model === model,
    `Snapshot entry model mismatch: expected ${model}, got ${entry.model}`,
  );
}

function serializeEntries(entries: readonly SnapshotEntry[]): string {
  if (entries.length === 0) {
    return '';
  }

  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

export function snapshotFilePath(
  snapshotDir: string,
  provider: string,
  model: string,
): string {
  const resolvedSnapshotDir = resolveSnapshotDir(snapshotDir);
  validatePathSegment(provider, 'provider');
  validatePathSegment(model, 'model');

  return assertPathInsideBase(
    resolvedSnapshotDir,
    resolve(resolvedSnapshotDir, `${provider}-${model}.jsonl`),
    'snapshot file path',
  );
}

export async function loadSnapshotFile(
  options: LoadSnapshotFileOptions,
): Promise<{
  entries: SnapshotEntry[];
  diagnostics: SnapshotLoadDiagnostic[];
}> {
  const path = snapshotFilePath(
    options.snapshotDir,
    options.provider,
    options.model,
  );
  const diagnostics: SnapshotLoadDiagnostic[] = [];

  let rawContents: string;
  try {
    rawContents = await readFile(path, 'utf8');
  } catch (error) {
    if ((options.allowMissing ?? true) && isEnoentError(error)) {
      return { entries: [], diagnostics };
    }

    throw error;
  }

  const lines = rawContents.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }

  const entries: SnapshotEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        kind: 'malformed',
        path,
        lineNumber,
        message,
      });
      warnSkippedSnapshotEntry(path, lineNumber, message);
      continue;
    }

    const parsedEntry = SnapshotEntrySchema.safeParse(parsedJson);
    if (!parsedEntry.success) {
      const message = parsedEntry.error.message;
      diagnostics.push({
        kind: 'malformed',
        path,
        lineNumber,
        message,
      });
      warnSkippedSnapshotEntry(path, lineNumber, message);
      continue;
    }

    if (options.validCurrentKeys !== undefined) {
      const key = buildSnapshotEntryKey(parsedEntry.data);
      if (!options.validCurrentKeys.has(key)) {
        const message = `stale snapshot key ${key}`;
        diagnostics.push({
          kind: 'stale',
          path,
          lineNumber,
          message,
        });
        warnSkippedSnapshotEntry(path, lineNumber, message);
        continue;
      }
    }

    entries.push(parsedEntry.data);
  }

  return { entries, diagnostics };
}

export async function writeSnapshotFile(
  options: WriteSnapshotFileOptions,
): Promise<void> {
  const path = snapshotFilePath(
    options.snapshotDir,
    options.provider,
    options.model,
  );
  const parsedEntries = SnapshotEntryArraySchema.safeParse(options.entries);
  if (!parsedEntries.success) {
    invariant(
      false,
      `Snapshot entries validation failed: ${parsedEntries.error.message}`,
    );
  }

  const incomingEntries = parsedEntries.data;
  const incomingEntriesByKey = new Map<string, SnapshotEntry>();
  for (const entry of incomingEntries) {
    assertEntryMatchesFile(entry, options.provider, options.model);

    const key = buildSnapshotEntryKey(entry);
    invariant(
      !incomingEntriesByKey.has(key),
      `Duplicate snapshot entry key in write request: ${key}`,
    );
    incomingEntriesByKey.set(key, entry);
  }

  const existingFile = await loadSnapshotFile({
    snapshotDir: options.snapshotDir,
    provider: options.provider,
    model: options.model,
    allowMissing: true,
  });

  const mergedEntries: SnapshotEntry[] = [];
  const seenExistingKeys = new Set<string>();
  for (const entry of existingFile.entries) {
    const key = buildSnapshotEntryKey(entry);
    if (seenExistingKeys.has(key)) {
      continue;
    }

    seenExistingKeys.add(key);
    const replacement = incomingEntriesByKey.get(key);
    if (replacement === undefined) {
      mergedEntries.push(entry);
      continue;
    }

    mergedEntries.push(replacement);
    incomingEntriesByKey.delete(key);
  }

  for (const entry of incomingEntries) {
    const key = buildSnapshotEntryKey(entry);
    if (!incomingEntriesByKey.has(key)) {
      continue;
    }

    mergedEntries.push(entry);
    incomingEntriesByKey.delete(key);
  }

  await writeTextFileAtomic({
    path,
    pathLabel: 'snapshot file path',
    contents: serializeEntries(mergedEntries),
    writeErrorMessage: `Failed to write snapshot file at ${path}.`,
  });
}
