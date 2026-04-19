import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSnapshotLogicalKey } from '../../../../evals/snapshots/schema.js';
import {
  loadSnapshotFile,
  snapshotFilePath,
  writeSnapshotFile,
} from '../../../../evals/snapshots/store.js';
import type { SnapshotEntry } from '../../../../evals/snapshots/schema.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createSnapshotDir(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'eval-snapshots-')),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function createSnapshotEntry(
  overrides: Partial<SnapshotEntry> = {},
): SnapshotEntry {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    lane: 'prompt',
    caseId: 'case-1',
    condition: 'preloaded',
    caseFingerprint: 'a'.repeat(64),
    inputTokens: 120,
    outputTokens: 40,
    totalTokens: 160,
    cachedTokens: 8,
    createdAtMs: 1_713_456_789_000,
    ...overrides,
  };
}

describe('snapshot store', () => {
  it('round-trips JSONL snapshot entries', async () => {
    const snapshotDir = await createSnapshotDir();
    const entry = createSnapshotEntry();

    await writeSnapshotFile({
      snapshotDir,
      provider: entry.provider,
      model: entry.model,
      entries: [entry],
    });

    const loaded = await loadSnapshotFile({
      snapshotDir,
      provider: entry.provider,
      model: entry.model,
    });

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.entries).toEqual([entry]);
    await expect(
      readFile(
        snapshotFilePath(snapshotDir, entry.provider, entry.model),
        'utf8',
      ),
    ).resolves.toBe(`${JSON.stringify(entry)}\n`);
  });

  it('leaves the original file untouched when validation fails before commit', async () => {
    const snapshotDir = await createSnapshotDir();
    const entry = createSnapshotEntry();
    const path = snapshotFilePath(snapshotDir, entry.provider, entry.model);

    await writeSnapshotFile({
      snapshotDir,
      provider: entry.provider,
      model: entry.model,
      entries: [entry],
    });
    const originalContents = await readFile(path, 'utf8');

    await expect(
      writeSnapshotFile({
        snapshotDir,
        provider: entry.provider,
        model: entry.model,
        entries: [
          {
            ...entry,
            totalTokens: -1,
          } as SnapshotEntry,
        ],
      }),
    ).rejects.toThrow(/Snapshot entries validation failed/u);

    await expect(readFile(path, 'utf8')).resolves.toBe(originalContents);
    await expect(readdir(snapshotDir)).resolves.not.toContainEqual(
      expect.stringContaining('.tmp-'),
    );
  });

  it('warns and skips malformed or stale entries while loading', async () => {
    const snapshotDir = await createSnapshotDir();
    const currentEntry = createSnapshotEntry();
    const staleEntry = createSnapshotEntry({
      caseId: 'case-2',
      caseFingerprint: 'b'.repeat(64),
      totalTokens: 190,
    });
    const path = snapshotFilePath(
      snapshotDir,
      currentEntry.provider,
      currentEntry.model,
    );
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await writeFile(
      path,
      [
        'not valid json',
        JSON.stringify(currentEntry),
        JSON.stringify(staleEntry),
      ].join('\n') + '\n',
      'utf8',
    );

    const loaded = await loadSnapshotFile({
      snapshotDir,
      provider: currentEntry.provider,
      model: currentEntry.model,
      validCurrentKeys: new Set([buildSnapshotLogicalKey(currentEntry)]),
    });

    expect(loaded.entries).toEqual([currentEntry]);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({ kind: 'malformed', lineNumber: 1, path }),
      expect.objectContaining({ kind: 'stale', lineNumber: 3, path }),
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`[evals] Skipping snapshot entry at ${path}:1:`),
    );
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`[evals] Skipping snapshot entry at ${path}:3:`),
    );
  });

  it('merges rewrites by logical key instead of appending duplicates', async () => {
    const snapshotDir = await createSnapshotDir();
    const originalEntry = createSnapshotEntry();
    const preservedEntry = createSnapshotEntry({
      caseId: 'case-2',
      caseFingerprint: 'b'.repeat(64),
      totalTokens: 210,
    });
    const updatedEntry = createSnapshotEntry({
      totalTokens: 175,
      createdAtMs: originalEntry.createdAtMs + 1_000,
    });
    const appendedEntry = createSnapshotEntry({
      caseId: 'case-3',
      caseFingerprint: 'c'.repeat(64),
      totalTokens: 220,
    });
    const path = snapshotFilePath(
      snapshotDir,
      originalEntry.provider,
      originalEntry.model,
    );

    await writeSnapshotFile({
      snapshotDir,
      provider: originalEntry.provider,
      model: originalEntry.model,
      entries: [originalEntry, preservedEntry],
    });
    await writeSnapshotFile({
      snapshotDir,
      provider: originalEntry.provider,
      model: originalEntry.model,
      entries: [updatedEntry, appendedEntry],
    });

    const fileContents = await readFile(path, 'utf8');
    const parsedEntries = fileContents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SnapshotEntry);

    expect(parsedEntries).toEqual([
      updatedEntry,
      preservedEntry,
      appendedEntry,
    ]);
  });
});
