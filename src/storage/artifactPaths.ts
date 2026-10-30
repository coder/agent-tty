import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

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
  invariant(
    Number.isInteger(value) && value >= 0,
    `${label} must be a non-negative integer`,
  );
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
  const sanitizedProfileName = sanitizeFilenameComponent(
    profileName,
    'profileName',
  );
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

function recordingExtension(format: string): string {
  invariant(
    format === 'asciicast' || format === 'webm' || format === 'svg',
    `unsupported recording format: ${format}`,
  );
  return format === 'asciicast' ? 'cast' : format;
}

export function recordingFilename(
  seq: number,
  format: string,
  variant?: string,
): string {
  assertNonNegativeInteger(seq, 'seq');
  const sanitizedFormat = sanitizeFilenameComponent(format, 'format');
  const extension = recordingExtension(sanitizedFormat);
  // A variant label distinguishes default filenames for exports of the same
  // format and seq that produce different content (e.g. animated vs still
  // SVG), so one cannot silently overwrite the other's artifact file.
  const variantSuffix =
    variant === undefined
      ? ''
      : `-${sanitizeFilenameComponent(variant, 'variant')}`;
  return `recording-${String(seq)}-${sanitizedFormat}${variantSuffix}.${extension}`;
}

export function videoFilename(seq: number, profileName: string): string {
  assertNonNegativeInteger(seq, 'seq');
  const sanitizedProfileName = sanitizeFilenameComponent(
    profileName,
    'profileName',
  );
  return `video-${String(seq)}-${sanitizedProfileName}.mp4`;
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

function sessionNotFoundError(sessionDirectory: string, cause: unknown) {
  const sessionId = basename(sessionDirectory);
  return makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
    message: `Session "${sessionId}" was not found: its folder ${sessionDirectory} no longer exists.`,
    details: { sessionId, sessionDir: sessionDirectory },
    cause,
  });
}

export async function ensureArtifactsDir(sessionDir: string): Promise<string> {
  const directory = artifactsDir(sessionDir);

  try {
    await mkdir(directory);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw sessionNotFoundError(dirname(directory), error);
    }

    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }

  return directory;
}

/**
 * Returns SESSION_NOT_FOUND for an ENOENT from a write under the session
 * folder when gc removed that folder, and any other error unchanged.
 */
export async function sessionNotFoundIfRemoved(
  sessionDir: string,
  error: unknown,
): Promise<unknown> {
  assertAbsolutePath(sessionDir, 'sessionDir');

  if (!hasErrorCode(error, 'ENOENT')) {
    return error;
  }

  try {
    await stat(sessionDir);
    return error;
  } catch (statError) {
    return hasErrorCode(statError, 'ENOENT')
      ? sessionNotFoundError(resolve(sessionDir), error)
      : error;
  }
}
