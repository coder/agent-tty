import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { assertString, invariant } from '../util/assert.js';

export type ArtifactKind =
  | 'screenshot'
  | 'video'
  | 'recording'
  | 'json'
  | 'notes'
  | 'script'
  | 'support'
  | 'other';

export interface BundleArtifact {
  kind: ArtifactKind;
  relativePath: string;
  fileName: string;
  sizeBytes: number;
}

export interface ReviewBundleIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface NormalizedBundleMetadata {
  bundleDirName: string;
  title: string;
  description?: string | undefined;
  manifestFacts: Array<{ label: string; value: string }>;
  commandLabels: string[];
  manifestArtifactPaths: string[];
  source: 'schema' | 'legacy' | 'scan';
}

export interface ReviewBundlePageModel {
  bundleDirName: string;
  title: string;
  description?: string | undefined;
  manifestFacts: Array<{ label: string; value: string }>;
  commandLabels: string[];
  warnings: string[];
  screenshots: BundleArtifact[];
  videos: BundleArtifact[];
  recordings: BundleArtifact[];
  jsonOutputs: Array<{ relativePath: string; formatted: string }>;
  notes: Array<{ relativePath: string; html: string }>;
  commands?: { relativePath: string; content: string } | undefined;
  commandStatus?: { headers: string[]; rows: string[][] } | undefined;
  allArtifacts: BundleArtifact[];
}

/* eslint-disable @typescript-eslint/no-deprecated -- review-bundle intentionally uses passthrough manifests to keep legacy dogfood bundles readable. */
const COMMAND_ENTRY_SCHEMA = z
  .union([
    z.string(),
    z
      .object({
        name: z.string().optional(),
        step: z.string().optional(),
        command: z.string().optional(),
        argv: z.array(z.string()).optional(),
      })
      .passthrough(),
  ])
  .optional();

const MANIFEST_ARTIFACT_SCHEMA = z
  .object({
    path: z.string().optional(),
    filename: z.string().optional(),
    kind: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    sha256: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const BundleManifestSchema = z
  .object({
    bundle: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    summary: z.string().optional(),
    createdAt: z.string().optional(),
    date: z.string().optional(),
    scenario: z.string().optional(),
    sessionId: z.string().optional(),
    result: z.string().optional(),
    fixture: z.string().optional(),
    lane: z.string().optional(),
    week: z.union([z.string(), z.number().int()]).optional(),
    commands: z.array(COMMAND_ENTRY_SCHEMA).optional(),
    artifacts: z
      .union([
        z.array(MANIFEST_ARTIFACT_SCHEMA),
        z.record(z.string(), MANIFEST_ARTIFACT_SCHEMA),
      ])
      .optional(),
  })
  .passthrough();
/* eslint-enable @typescript-eslint/no-deprecated */

const NOTE_FILE_NAMES = new Set([
  'README.md',
  'NOTES.md',
  'index.md',
  'notes.md',
]);
const SCRIPT_FILE_NAMES = new Set(['commands.sh', 'run-scenario.sh']);
const SUPPORT_FILE_NAMES = new Set([
  'manifest.json',
  'command-status.tsv',
  'doctor.json',
  'session-id.txt',
  'agent-terminal-home.txt',
  'events.jsonl',
  'event-log.jsonl',
]);

function defaultIo(): ReviewBundleIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function writeLine(write: (text: string) => void, line: string): void {
  write(`${line}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSeparators(value: string): string {
  return value.split(sep).join('/');
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relPath = relative(rootPath, candidatePath);
  return relPath === '' || (!relPath.startsWith('..') && !isAbsolute(relPath));
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function firstNonEmptyString(
  values: Array<string | undefined>,
): string | undefined {
  return values
    .find((value) => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function maybeString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function maybeScalarString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value === 'number') {
    return String(value);
  }
  return maybeString(record, key);
}

function safeManifestArtifactArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    return Object.values(value).filter(isRecord);
  }
  return [];
}

function extractCommandLabels(record: Record<string, unknown>): string[] {
  const commands = record.commands;
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands
    .map((command) => {
      if (typeof command === 'string') {
        return command.trim();
      }
      if (!isRecord(command)) {
        return undefined;
      }

      const argv = Array.isArray(command.argv)
        ? command.argv.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [];

      return firstNonEmptyString([
        maybeString(command, 'name'),
        maybeString(command, 'step'),
        maybeString(command, 'command'),
        argv.length > 0 ? argv.join(' ') : undefined,
      ]);
    })
    .filter(
      (command): command is string =>
        typeof command === 'string' && command.length > 0,
    );
}

function extractManifestArtifactPaths(
  record: Record<string, unknown>,
): string[] {
  return safeManifestArtifactArray(record.artifacts)
    .map((artifact) => {
      const pathValue = maybeString(artifact, 'path');
      if (pathValue !== undefined) {
        return pathValue;
      }
      const filename = maybeString(artifact, 'filename');
      return filename === undefined ? undefined : `artifacts/${filename}`;
    })
    .filter((pathValue): pathValue is string => typeof pathValue === 'string');
}

function normalizeBundleMetadataRecord(
  record: Record<string, unknown>,
  bundleDirName: string,
  source: 'schema' | 'legacy',
): NormalizedBundleMetadata {
  const title = firstNonEmptyString([
    maybeString(record, 'title'),
    maybeString(record, 'scenario'),
    maybeString(record, 'bundle'),
    bundleDirName,
  ]);
  invariant(
    title !== undefined,
    'bundle title must resolve from manifest or directory name',
  );

  const description = firstNonEmptyString([
    maybeString(record, 'description'),
    maybeString(record, 'summary'),
  ]);
  const commandLabels = extractCommandLabels(record);
  const manifestArtifactPaths = extractManifestArtifactPaths(record);
  const manifestFacts: Array<{ label: string; value: string }> = [];

  const addFact = (label: string, value: string | undefined): void => {
    if (value !== undefined) {
      manifestFacts.push({ label, value });
    }
  };

  addFact('Bundle', maybeString(record, 'bundle'));
  addFact('Scenario', maybeString(record, 'scenario'));
  addFact(
    'Date',
    firstNonEmptyString([
      maybeString(record, 'date'),
      maybeString(record, 'createdAt'),
    ]),
  );
  addFact('Session ID', maybeString(record, 'sessionId'));
  addFact('Result', maybeString(record, 'result'));
  addFact('Fixture', maybeString(record, 'fixture'));
  addFact('Lane', maybeString(record, 'lane'));
  addFact('Week', maybeScalarString(record, 'week'));
  if (commandLabels.length > 0) {
    addFact('Commands', String(commandLabels.length));
  }
  const artifactCount = safeManifestArtifactArray(record.artifacts).length;
  if (artifactCount > 0) {
    addFact('Manifest artifacts', String(artifactCount));
  }

  return {
    bundleDirName,
    title,
    description,
    manifestFacts,
    commandLabels,
    manifestArtifactPaths,
    source,
  };
}

export function normalizeBundleManifest(
  raw: unknown,
  bundleDirName: string,
): NormalizedBundleMetadata {
  const parsed = BundleManifestSchema.safeParse(raw);
  if (parsed.success) {
    return normalizeBundleMetadataRecord(parsed.data, bundleDirName, 'schema');
  }
  if (isRecord(raw)) {
    return normalizeBundleMetadataRecord(raw, bundleDirName, 'legacy');
  }
  return {
    bundleDirName,
    title: bundleDirName,
    manifestFacts: [],
    commandLabels: [],
    manifestArtifactPaths: [],
    source: 'scan',
  };
}

export function classifyBundlePath(relativePath: string): ArtifactKind {
  const normalizedPath = normalizeSeparators(relativePath);
  const fileName = basename(normalizedPath);
  const lowerFileName = fileName.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();

  if (NOTE_FILE_NAMES.has(fileName)) {
    return 'notes';
  }
  if (SCRIPT_FILE_NAMES.has(fileName)) {
    return 'script';
  }
  if (lowerFileName.endsWith('.png')) {
    return 'screenshot';
  }
  if (lowerFileName.endsWith('.webm')) {
    return 'video';
  }
  if (lowerFileName.endsWith('.cast')) {
    return 'recording';
  }
  if (SUPPORT_FILE_NAMES.has(fileName) || lowerPath.startsWith('logs/')) {
    return 'support';
  }
  if (lowerFileName.endsWith('.json') && lowerFileName !== 'manifest.json') {
    return 'json';
  }
  return 'other';
}

async function resolveBundleRoot(bundleRoot: string): Promise<string> {
  const resolvedPath = resolve(bundleRoot);
  const bundleStat = await stat(resolvedPath);
  invariant(
    bundleStat.isDirectory(),
    `bundle path is not a directory: ${resolvedPath}`,
  );
  return realpath(resolvedPath);
}

async function validateBundleRelativePath(
  bundleRoot: string,
  relativePath: string,
): Promise<string> {
  assertString(relativePath, 'manifest artifact path must be a string');
  invariant(
    relativePath.trim().length > 0,
    'manifest artifact path must not be empty',
  );
  invariant(
    !isAbsolute(relativePath),
    `bundle artifact path must be relative to the bundle root: ${relativePath}`,
  );

  const candidatePath = resolve(bundleRoot, relativePath);
  invariant(
    isWithinRoot(bundleRoot, candidatePath),
    `bundle artifact path escapes bundle root: ${relativePath}`,
  );

  try {
    const candidateRealPath = await realpath(candidatePath);
    invariant(
      isWithinRoot(bundleRoot, candidateRealPath),
      `bundle artifact path escapes bundle root via symlink: ${relativePath}`,
    );
  } catch {
    // Missing paths are validated syntactically above and may be absent in older manifests.
  }

  return candidatePath;
}

async function loadManifest(
  bundleRoot: string,
): Promise<{ raw: unknown; warnings: string[] }> {
  const manifestPath = join(bundleRoot, 'manifest.json');

  try {
    const manifestText = await readFile(manifestPath, 'utf8');
    try {
      const raw = JSON.parse(manifestText) as unknown;
      const warnings: string[] = [];
      if (!BundleManifestSchema.safeParse(raw).success && isRecord(raw)) {
        warnings.push(
          'manifest.json did not match the preferred schema; using legacy normalization.',
        );
      }
      return { raw, warnings };
    } catch (error) {
      return {
        raw: undefined,
        warnings: [
          `manifest.json could not be parsed as JSON; using filesystem scan (${String(error)}).`,
        ],
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      return {
        raw: undefined,
        warnings: ['manifest.json was not found; using filesystem scan only.'],
      };
    }
    throw error;
  }
}

async function validateManifestArtifactHints(
  bundleRoot: string,
  metadata: NormalizedBundleMetadata,
): Promise<string[]> {
  const warnings: string[] = [];

  for (const hintedPath of metadata.manifestArtifactPaths) {
    const candidatePath = await validateBundleRelativePath(
      bundleRoot,
      hintedPath,
    );
    try {
      const candidateStat = await stat(candidatePath);
      if (!candidateStat.isFile()) {
        warnings.push(`Manifest artifact is not a file: ${hintedPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT')) {
        warnings.push(`Manifest artifact was not found on disk: ${hintedPath}`);
        continue;
      }
      throw error;
    }
  }

  return warnings;
}

async function collectArtifactsFromDirectory(
  bundleRoot: string,
  currentDirectory: string,
  visitedDirectoryRealPaths: Set<string>,
  artifacts: BundleArtifact[],
): Promise<void> {
  const currentRealPath = await realpath(currentDirectory);
  invariant(
    isWithinRoot(bundleRoot, currentRealPath),
    `bundle directory escapes bundle root: ${currentDirectory}`,
  );
  if (visitedDirectoryRealPaths.has(currentRealPath)) {
    return;
  }
  visitedDirectoryRealPaths.add(currentRealPath);

  const entries = await readdir(currentDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = join(currentDirectory, entry.name);
    const entryStats = await lstat(fullPath);

    if (entryStats.isSymbolicLink()) {
      const targetRealPath = await realpath(fullPath);
      invariant(
        isWithinRoot(bundleRoot, targetRealPath),
        `bundle artifact path escapes bundle root via symlink: ${normalizeSeparators(relative(bundleRoot, fullPath))}`,
      );
      const targetStats = await stat(fullPath);
      if (targetStats.isDirectory()) {
        await collectArtifactsFromDirectory(
          bundleRoot,
          fullPath,
          visitedDirectoryRealPaths,
          artifacts,
        );
        continue;
      }
      if (!targetStats.isFile()) {
        continue;
      }
    }

    if (entryStats.isDirectory()) {
      await collectArtifactsFromDirectory(
        bundleRoot,
        fullPath,
        visitedDirectoryRealPaths,
        artifacts,
      );
      continue;
    }

    if (!entryStats.isFile() && !entryStats.isSymbolicLink()) {
      continue;
    }

    const relPath = normalizeSeparators(relative(bundleRoot, fullPath));
    if (relPath === 'index.html') {
      continue;
    }

    const fileStats = await stat(fullPath);
    artifacts.push({
      kind: classifyBundlePath(relPath),
      relativePath: relPath,
      fileName: basename(relPath),
      sizeBytes: fileStats.size,
    });
  }
}

export async function scanBundleArtifacts(
  bundleRoot: string,
): Promise<BundleArtifact[]> {
  const resolvedRoot = await resolveBundleRoot(bundleRoot);
  const artifacts: BundleArtifact[] = [];
  const visitedDirectoryRealPaths = new Set<string>();
  await collectArtifactsFromDirectory(
    resolvedRoot,
    resolvedRoot,
    visitedDirectoryRealPaths,
    artifacts,
  );
  return artifacts.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${String(sizeBytes)} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatInlineMarkdown(text: string): string {
  const codeTokens: string[] = [];
  const withoutCode = text.replace(
    /`([^`]+)`/g,
    (_match: string, code: string) => {
      const token = `@@CODE${String(codeTokens.length)}@@`;
      codeTokens.push(`<code>${htmlEscape(code)}</code>`);
      return token;
    },
  );

  let formatted = htmlEscape(withoutCode);
  formatted = formatted.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match: string, label: string, href: string) =>
      `<a href="${htmlEscape(href)}">${formatInlineMarkdown(label)}</a>`,
  );
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return formatted.replace(/@@CODE(\d+)@@/g, (_match, index) => {
    const token = codeTokens[Number(index)];
    invariant(token !== undefined, 'inline code token must exist');
    return token;
  });
}

export function renderTinyMarkdown(markdown: string): string {
  const normalized = markdown.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? '').trim().startsWith('```')
      ) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      html.push(
        `<pre><code class="language-${htmlEscape(language)}">${htmlEscape(codeLines.join('\n'))}</code></pre>`,
      );
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch !== null) {
      const hashes = headingMatch[1];
      const headingText = headingMatch[2];
      invariant(
        hashes !== undefined,
        'markdown heading level must be captured',
      );
      invariant(
        headingText !== undefined,
        'markdown heading text must be captured',
      );
      const level = hashes.length;
      html.push(
        `<h${String(level)}>${formatInlineMarkdown(headingText)}</h${String(level)}>`,
      );
      index += 1;
      continue;
    }

    const unorderedMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (unorderedMatch !== null) {
      const items: string[] = [];
      while (index < lines.length) {
        const listLine = (lines[index] ?? '').trim();
        const match = /^[-*+]\s+(.*)$/.exec(listLine);
        if (match === null) {
          break;
        }
        const itemText = match[1];
        invariant(
          itemText !== undefined,
          'unordered markdown list item must be captured',
        );
        items.push(`<li>${formatInlineMarkdown(itemText)}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const orderedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (orderedMatch !== null) {
      const items: string[] = [];
      while (index < lines.length) {
        const listLine = (lines[index] ?? '').trim();
        const match = /^\d+\.\s+(.*)$/.exec(listLine);
        if (match === null) {
          break;
        }
        const itemText = match[1];
        invariant(
          itemText !== undefined,
          'ordered markdown list item must be captured',
        );
        items.push(`<li>${formatInlineMarkdown(itemText)}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? '';
      const paragraphTrimmed = paragraphLine.trim();
      if (
        paragraphTrimmed.length === 0 ||
        paragraphTrimmed.startsWith('```') ||
        /^(#{1,6})\s+/.test(paragraphTrimmed) ||
        /^[-*+]\s+/.test(paragraphTrimmed) ||
        /^\d+\.\s+/.test(paragraphTrimmed)
      ) {
        break;
      }
      paragraphLines.push(paragraphTrimmed);
      index += 1;
    }
    html.push(`<p>${formatInlineMarkdown(paragraphLines.join(' '))}</p>`);
  }

  return html.join('\n');
}

function renderDefinitionList(
  facts: Array<{ label: string; value: string }>,
): string {
  if (facts.length === 0) {
    return '<p class="empty-state">No manifest metadata was available.</p>';
  }

  return `<dl class="facts">${facts
    .map(
      (fact) =>
        `<div><dt>${htmlEscape(fact.label)}</dt><dd>${htmlEscape(fact.value)}</dd></div>`,
    )
    .join('')}</dl>`;
}

function renderMediaGallery(
  title: string,
  artifacts: BundleArtifact[],
  mediaRenderer: (artifact: BundleArtifact) => string,
): string {
  if (artifacts.length === 0) {
    return '';
  }

  return `
<section>
  <h2>${htmlEscape(title)}</h2>
  <div class="gallery">
    ${artifacts
      .map(
        (artifact) => `
      <figure class="card">
        ${mediaRenderer(artifact)}
        <figcaption>
          <a href="${htmlEscape(artifact.relativePath)}">${htmlEscape(artifact.relativePath)}</a>
          <span>${htmlEscape(formatBytes(artifact.sizeBytes))}</span>
        </figcaption>
      </figure>`,
      )
      .join('')}
  </div>
</section>`.trim();
}

function renderJsonOutputs(
  jsonOutputs: Array<{ relativePath: string; formatted: string }>,
): string {
  if (jsonOutputs.length === 0) {
    return '';
  }

  return `
<section>
  <h2>JSON outputs</h2>
  ${jsonOutputs
    .map(
      (jsonOutput) => `
  <details class="card">
    <summary>${htmlEscape(jsonOutput.relativePath)}</summary>
    <pre><code>${htmlEscape(jsonOutput.formatted)}</code></pre>
  </details>`,
    )
    .join('')}
</section>`.trim();
}

function renderNotes(
  notes: Array<{ relativePath: string; html: string }>,
): string {
  if (notes.length === 0) {
    return '';
  }

  return `
<section>
  <h2>Notes</h2>
  ${notes
    .map(
      (note) => `
  <article class="card note-card">
    <h3><a href="${htmlEscape(note.relativePath)}">${htmlEscape(note.relativePath)}</a></h3>
    ${note.html}
  </article>`,
    )
    .join('')}
</section>`.trim();
}

function renderCommandStatusTable(statusTable?: {
  headers: string[];
  rows: string[][];
}): string {
  if (statusTable === undefined) {
    return '';
  }

  return `
<section>
  <h2>Command status</h2>
  <div class="table-scroll">
    <table>
      <thead>
        <tr>${statusTable.headers
          .map((header) => `<th>${htmlEscape(header)}</th>`)
          .join('')}</tr>
      </thead>
      <tbody>
        ${statusTable.rows
          .map(
            (row) =>
              `<tr>${row
                .map((cell) => `<td>${htmlEscape(cell)}</td>`)
                .join('')}</tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
</section>`.trim();
}

function renderArtifactInventory(artifacts: BundleArtifact[]): string {
  return `
<section>
  <h2>Artifact inventory</h2>
  <div class="table-scroll">
    <table>
      <thead>
        <tr><th>Path</th><th>Type</th><th>Size</th></tr>
      </thead>
      <tbody>
        ${artifacts
          .map(
            (artifact) => `
        <tr>
          <td><a href="${htmlEscape(artifact.relativePath)}">${htmlEscape(artifact.relativePath)}</a></td>
          <td>${htmlEscape(artifact.kind)}</td>
          <td>${htmlEscape(formatBytes(artifact.sizeBytes))}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>
</section>`.trim();
}

export function generateReviewBundleHtml(model: ReviewBundlePageModel): string {
  const warningSection =
    model.warnings.length > 0
      ? `
<section>
  <h2>Warnings</h2>
  <ul>${model.warnings
    .map((warning) => `<li>${htmlEscape(warning)}</li>`)
    .join('')}</ul>
</section>`.trim()
      : '';
  const manifestSummarySection = `
<section>
  <h2>Manifest summary</h2>
  ${renderDefinitionList(model.manifestFacts)}
  ${
    model.commandLabels.length > 0
      ? `<div class="card"><h3>Commands</h3><ul>${model.commandLabels
          .map((command) => `<li>${htmlEscape(command)}</li>`)
          .join('')}</ul></div>`
      : ''
  }
</section>`.trim();
  const commandsSection =
    model.commands === undefined
      ? ''
      : `
<section>
  <h2>Commands</h2>
  <div class="card">
    <h3><a href="${htmlEscape(model.commands.relativePath)}">${htmlEscape(model.commands.relativePath)}</a></h3>
    <pre><code>${htmlEscape(model.commands.content)}</code></pre>
  </div>
</section>`.trim();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(model.title)} review bundle</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f172a;
        --surface: #111827;
        --surface-raised: #1f2937;
        --text: #e5e7eb;
        --muted: #94a3b8;
        --accent: #93c5fd;
        --border: #334155;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: linear-gradient(180deg, #020617 0%, var(--bg) 100%);
        color: var(--text);
        line-height: 1.5;
      }
      main {
        max-width: 1200px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      a { color: var(--accent); }
      header, section, .card {
        background: rgb(15 23 42 / 0.88);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: 0 18px 40px rgb(2 6 23 / 0.25);
      }
      header, section {
        padding: 24px;
        margin-bottom: 20px;
      }
      h1, h2, h3, h4, h5, h6 {
        margin-top: 0;
        color: #f8fafc;
      }
      p, li, dd, td, th, summary, figcaption {
        overflow-wrap: anywhere;
      }
      .subtle {
        color: var(--muted);
      }
      .facts {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin: 0;
      }
      .facts div {
        padding: 12px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
      }
      .facts dt {
        font-size: 0.85rem;
        color: var(--muted);
      }
      .facts dd {
        margin: 6px 0 0;
        font-weight: 600;
      }
      .gallery {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .card {
        padding: 16px;
      }
      .note-card > *:last-child {
        margin-bottom: 0;
      }
      img, video {
        width: 100%;
        border-radius: 12px;
        background: #020617;
        border: 1px solid var(--border);
      }
      figure {
        margin: 0;
      }
      figcaption {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-top: 12px;
        color: var(--muted);
      }
      pre {
        padding: 16px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow-x: auto;
        white-space: pre-wrap;
      }
      code {
        font-family: 'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      details > summary {
        cursor: pointer;
        font-weight: 600;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        color: #f8fafc;
      }
      .table-scroll {
        overflow-x: auto;
      }
      .empty-state {
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="subtle">Portable review bundle</p>
        <h1>${htmlEscape(model.title)}</h1>
        <p class="subtle">Bundle directory: ${htmlEscape(model.bundleDirName)}</p>
        ${
          model.description === undefined
            ? ''
            : `<p>${htmlEscape(model.description)}</p>`
        }
      </header>
      ${warningSection}
      ${manifestSummarySection}
      ${renderMediaGallery(
        'Screenshot gallery',
        model.screenshots,
        (artifact) =>
          `<img src="${htmlEscape(artifact.relativePath)}" alt="${htmlEscape(artifact.fileName)}" loading="lazy" />`,
      )}
      ${renderMediaGallery(
        'Video gallery',
        model.videos,
        (artifact) =>
          `<video controls preload="metadata" src="${htmlEscape(artifact.relativePath)}"></video>`,
      )}
      ${
        model.recordings.length === 0
          ? ''
          : `
<section>
  <h2>Recordings</h2>
  <ul>${model.recordings
    .map(
      (recording) =>
        `<li><a href="${htmlEscape(recording.relativePath)}">${htmlEscape(recording.relativePath)}</a> <span class="subtle">(${htmlEscape(formatBytes(recording.sizeBytes))})</span></li>`,
    )
    .join('')}</ul>
</section>`.trim()
      }
      ${renderJsonOutputs(model.jsonOutputs)}
      ${renderNotes(model.notes)}
      ${commandsSection}
      ${renderCommandStatusTable(model.commandStatus)}
      ${renderArtifactInventory(model.allArtifacts)}
    </main>
  </body>
</html>`;
}

async function maybeReadTextFile(
  bundleRoot: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    const filePath = await validateBundleRelativePath(bundleRoot, relativePath);
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      return undefined;
    }
    return await readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function parseCommandStatusTable(content: string):
  | {
      headers: string[];
      rows: string[][];
    }
  | undefined {
  const lines = content
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  const [headerLine, ...rowLines] = lines;
  invariant(headerLine !== undefined, 'command status header row must exist');

  return {
    headers: headerLine.split('\t'),
    rows: rowLines.map((line) => line.split('\t')),
  };
}

async function buildReviewBundleInternal(
  bundleRoot: string,
): Promise<{ indexPath: string; warnings: string[] }> {
  const resolvedBundleRoot = await resolveBundleRoot(bundleRoot);
  const bundleDirName = basename(resolvedBundleRoot);
  const manifest = await loadManifest(resolvedBundleRoot);
  const metadata = normalizeBundleManifest(manifest.raw, bundleDirName);
  const warnings = [...manifest.warnings];
  warnings.push(
    ...(await validateManifestArtifactHints(resolvedBundleRoot, metadata)),
  );

  const artifacts = await scanBundleArtifacts(resolvedBundleRoot);
  const notes = await Promise.all(
    artifacts
      .filter((artifact) => artifact.kind === 'notes')
      .map(async (artifact) => ({
        relativePath: artifact.relativePath,
        html: renderTinyMarkdown(
          await readFile(
            join(resolvedBundleRoot, artifact.relativePath),
            'utf8',
          ),
        ),
      })),
  );
  const jsonOutputs = await Promise.all(
    artifacts
      .filter(
        (artifact) => extname(artifact.relativePath).toLowerCase() === '.json',
      )
      .filter((artifact) => artifact.fileName !== 'manifest.json')
      .map(async (artifact) => {
        const content = await readFile(
          join(resolvedBundleRoot, artifact.relativePath),
          'utf8',
        );
        try {
          return {
            relativePath: artifact.relativePath,
            formatted: JSON.stringify(JSON.parse(content) as unknown, null, 2),
          };
        } catch {
          return { relativePath: artifact.relativePath, formatted: content };
        }
      }),
  );
  const commandsContent = await maybeReadTextFile(
    resolvedBundleRoot,
    'commands.sh',
  );
  const commandStatusContent = await maybeReadTextFile(
    resolvedBundleRoot,
    'command-status.tsv',
  );

  const html = generateReviewBundleHtml({
    bundleDirName,
    title: metadata.title,
    description: metadata.description,
    manifestFacts: [
      ...metadata.manifestFacts,
      { label: 'Discovered files', value: String(artifacts.length) },
    ],
    commandLabels: metadata.commandLabels,
    warnings,
    screenshots: artifacts.filter((artifact) => artifact.kind === 'screenshot'),
    videos: artifacts.filter((artifact) => artifact.kind === 'video'),
    recordings: artifacts.filter((artifact) => artifact.kind === 'recording'),
    jsonOutputs,
    notes,
    commands:
      commandsContent === undefined
        ? undefined
        : { relativePath: 'commands.sh', content: commandsContent },
    commandStatus:
      commandStatusContent === undefined
        ? undefined
        : parseCommandStatusTable(commandStatusContent),
    allArtifacts: artifacts,
  });

  const indexPath = join(resolvedBundleRoot, 'index.html');
  await mkdir(resolvedBundleRoot, { recursive: true });
  await writeFile(indexPath, html, 'utf8');
  return { indexPath, warnings };
}

export async function buildReviewBundle(bundleRoot: string): Promise<string> {
  const { indexPath } = await buildReviewBundleInternal(bundleRoot);
  return indexPath;
}

export async function runReviewBundleCli(
  args: readonly string[],
  io: ReviewBundleIo = defaultIo(),
): Promise<number> {
  const argumentsList = [...args];
  if (argumentsList.length === 0) {
    writeLine(
      io.stderr,
      'usage: review-bundle <bundle-dir> | review-bundle --all <parent-dir>',
    );
    return 1;
  }

  if (argumentsList[0] === '--all') {
    if (argumentsList.length !== 2) {
      writeLine(io.stderr, 'expected exactly one parent directory after --all');
      return 1;
    }

    const parentArgument = argumentsList[1];
    invariant(
      parentArgument !== undefined,
      'parent directory argument must exist',
    );
    const parentDirectory = resolve(parentArgument);
    try {
      const parentStats = await stat(parentDirectory);
      invariant(
        parentStats.isDirectory(),
        `parent path is not a directory: ${parentDirectory}`,
      );
    } catch (error) {
      writeLine(
        io.stderr,
        `Failed to inspect ${parentArgument}: ${String(error)}`,
      );
      return 1;
    }

    const children = (await readdir(parentDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    let hadFailure = false;

    for (const child of children) {
      const childPath = join(parentDirectory, child);
      writeLine(io.stderr, `Building ${childPath}`);
      try {
        const result = await buildReviewBundleInternal(childPath);
        for (const warning of result.warnings) {
          writeLine(io.stderr, `warning: ${warning}`);
        }
        writeLine(io.stdout, result.indexPath);
      } catch (error) {
        hadFailure = true;
        writeLine(io.stderr, `Failed to build ${childPath}: ${String(error)}`);
      }
    }

    return hadFailure ? 1 : 0;
  }

  if (argumentsList.length !== 1) {
    writeLine(io.stderr, 'expected exactly one bundle directory');
    return 1;
  }

  const bundleArgument = argumentsList[0];
  invariant(
    bundleArgument !== undefined,
    'bundle directory argument must exist',
  );

  try {
    writeLine(io.stderr, `Building ${bundleArgument}`);
    const result = await buildReviewBundleInternal(bundleArgument);
    for (const warning of result.warnings) {
      writeLine(io.stderr, `warning: ${warning}`);
    }
    writeLine(io.stdout, result.indexPath);
    return 0;
  } catch (error) {
    writeLine(io.stderr, `Failed to build ${bundleArgument}: ${String(error)}`);
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isDirectExecution()) {
  const exitCode = await runReviewBundleCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
