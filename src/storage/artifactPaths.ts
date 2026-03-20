import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { invariant } from '../util/assert.js';

const ARTIFACTS_DIRNAME = 'artifacts';
const SAFE_FILENAME_COMPONENT_PATTERN = /[^a-zA-Z0-9._-]+/g;
const TRIMMED_HYPHEN_PATTERN = /^-+|-+$/g;

function assertNonEmptyString(
  value: string,
  label: string,
): asserts value is string {
  invariant(
    typeof value === 'string' && value.length > 0,
    `${label} must be a non-empty string`,
  );
}

function assertNonNegativeInteger(value: number, label: string): void {
  invariant(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer`);
}

function assertAbsolutePath(pathValue: string, label: string): void {
  assertNonEmptyString(pathValue, label);
  invariant(isAbsolute(pathValue), `${label} must be an absolute path`);
}

function sanitizeFilenameComponent(value: string, label: string): string {
  assertNonEmptyString(value, label);

  const sanitizedValue = value
    .trim()
    .replace(SAFE_FILENAME_COMPONENT_PATTERN, '-')
    .replace(TRIMMED_HYPHEN_PATTERN, '');

  invariant(
    sanitizedValue.length > 0,
    `${label} must contain at least one filename-safe character`,
  );

  return sanitizedValue;
}

function artifactsDir(sessionDir: string): string {
  assertAbsolutePath(sessionDir, 'sessionDir');

  const normalizedSessionDir = resolve(sessionDir);
  const directory = resolve(normalizedSessionDir, ARTIFACTS_DIRNAME);

  invariant(
    dirname(directory) === normalizedSessionDir,
    'artifacts directory must stay within the session directory',
  );

  return directory;
}

export function screenshotFilename(seq: number, profileName: string): string {
  assertNonNegativeInteger(seq, 'seq');
  const sanitizedProfileName = sanitizeFilenameComponent(profileName, 'profileName');
  return `screenshot-${String(seq)}-${sanitizedProfileName}.png`;
}

export function snapshotFilename(
  seq: number,
  format: 'structured' | 'text',
): string {
  assertNonNegativeInteger(seq, 'seq');
  const sanitizedFormat = sanitizeFilenameComponent(format, 'format');
  return `snapshot-${String(seq)}-${sanitizedFormat}.json`;
}

export function artifactPath(sessionDir: string, filename: string): string {
  const directory = artifactsDir(sessionDir);
  assertNonEmptyString(filename, 'filename');
  invariant(
    !filename.includes('/') && !filename.includes('\\'),
    'filename must not contain path separators',
  );

  const resolvedArtifactPath = resolve(directory, filename);
  invariant(
    dirname(resolvedArtifactPath) === directory,
    'artifact path must be created directly within the artifacts directory',
  );

  return resolvedArtifactPath;
}

export async function ensureArtifactsDir(sessionDir: string): Promise<string> {
  const directory = artifactsDir(sessionDir);
  await mkdir(directory, { recursive: true });
  return directory;
}
