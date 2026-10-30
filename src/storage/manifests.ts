import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { SessionRecordSchema } from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';
import type { SessionRecord } from '../protocol/schemas.js';

interface NodeError {
  code?: string;
}

export interface ReadValidatedJsonFileOptions<T> {
  path: string;
  pathLabel: string;
  allowMissing: boolean;
  readErrorMessage: string;
  invalidJsonMessage: string;
  validate: (path: string, data: unknown) => T;
}

export interface WriteValidatedJsonFileOptions<T> {
  path: string;
  pathLabel: string;
  data: T;
  writeErrorMessage: string;
  validate: (path: string, data: unknown) => T;
  createParentFolders?: boolean;
}

export interface WriteTextFileAtomicOptions {
  path: string;
  pathLabel: string;
  contents: string;
  writeErrorMessage: string;
  /**
   * Defaults to true. Pass false for a file inside a session folder: gc can
   * remove that folder at any time, and the write must then fail instead of
   * creating the folder again.
   */
  createParentFolders?: boolean;
}

function assertAbsoluteStoragePath(path: string, label: string): void {
  invariant(path.length > 0, `${label} must be a non-empty string`);
  invariant(isAbsolute(path), `${label} must be absolute`);
}

function isEnoentError(error: unknown): error is Error & NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeError).code === 'ENOENT'
  );
}

function parseValidatedJson<T>(
  path: string,
  rawContents: string,
  invalidJsonMessage: string,
  validate: (path: string, data: unknown) => T,
): T {
  try {
    return validate(path, JSON.parse(rawContents) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
        message: invalidJsonMessage,
        details: { path },
        cause: error,
      });
    }

    throw error;
  }
}

export async function readValidatedJsonFile<T>(
  options: ReadValidatedJsonFileOptions<T>,
): Promise<T | null> {
  assertAbsoluteStoragePath(options.path, options.pathLabel);

  let rawContents: string;
  try {
    rawContents = await readFile(options.path, 'utf8');
  } catch (error) {
    if (options.allowMissing && isEnoentError(error)) {
      return null;
    }

    throw makeCliError(ERROR_CODES.STORAGE_READ_ERROR, {
      message: options.readErrorMessage,
      details: { path: options.path },
      cause: error,
    });
  }

  return parseValidatedJson(
    options.path,
    rawContents,
    options.invalidJsonMessage,
    options.validate,
  );
}

async function replaceFileAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;

  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function replaceFileAtomicSync(path: string, contents: string): void {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;

  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // keep the write error
    }
    throw error;
  }
}

export async function writeTextFileAtomic(
  options: WriteTextFileAtomicOptions,
): Promise<void> {
  assertAbsoluteStoragePath(options.path, options.pathLabel);

  try {
    if (options.createParentFolders !== false) {
      await mkdir(dirname(options.path), { recursive: true });
    }
    await replaceFileAtomic(options.path, options.contents);
  } catch (error) {
    throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: options.writeErrorMessage,
      details: { path: options.path },
      cause: error,
    });
  }
}

export async function writeValidatedJsonFile<T>(
  options: WriteValidatedJsonFileOptions<T>,
): Promise<void> {
  const validatedData = options.validate(options.path, options.data);

  await writeTextFileAtomic({
    path: options.path,
    pathLabel: options.pathLabel,
    contents: `${JSON.stringify(validatedData, null, 2)}\n`,
    writeErrorMessage: options.writeErrorMessage,
    ...(options.createParentFolders === undefined
      ? {}
      : { createParentFolders: options.createParentFolders }),
  });
}

// For a caller that must not yield to the event loop. Unlike
// writeValidatedJsonFile it never creates a missing folder.
export function writeValidatedJsonFileSync<T>(
  options: WriteValidatedJsonFileOptions<T>,
): void {
  assertAbsoluteStoragePath(options.path, options.pathLabel);
  const validatedData = options.validate(options.path, options.data);

  try {
    replaceFileAtomicSync(
      options.path,
      `${JSON.stringify(validatedData, null, 2)}\n`,
    );
  } catch (error) {
    throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: options.writeErrorMessage,
      details: { path: options.path },
      cause: error,
    });
  }
}

function validateManifestData(path: string, data: unknown): SessionRecord {
  const parsedManifest = SessionRecordSchema.safeParse(data);

  if (parsedManifest.success) {
    return parsedManifest.data;
  }

  throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
    message: `Session manifest validation failed for ${path}.`,
    details: {
      path,
      issues: parsedManifest.error.issues,
    },
  });
}

async function readManifestInternal(
  path: string,
  allowMissing: boolean,
): Promise<SessionRecord | null> {
  return readValidatedJsonFile({
    path,
    pathLabel: 'manifest path',
    allowMissing,
    readErrorMessage: `Failed to read session manifest at ${path}.`,
    invalidJsonMessage: `Session manifest contains invalid JSON at ${path}.`,
    validate: validateManifestData,
  });
}

export async function readManifest(path: string): Promise<SessionRecord> {
  const manifest = await readManifestInternal(path, false);

  invariant(manifest !== null, 'readManifest must return a manifest record');

  return manifest;
}

export async function readManifestIfExists(
  path: string,
): Promise<SessionRecord | null> {
  return readManifestInternal(path, true);
}

export async function writeManifest(
  path: string,
  record: SessionRecord,
): Promise<void> {
  assertAbsoluteStoragePath(path, 'manifest path');
  const manifest = validateManifestData(path, record);

  try {
    await replaceFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (isEnoentError(error)) {
      throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
        message: `Session "${manifest.sessionId}" was not found: its folder ${dirname(path)} no longer exists.`,
        details: { sessionId: manifest.sessionId, manifestPath: path },
        cause: error,
      });
    }

    throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: `Failed to write session manifest at ${path}.`,
      details: { path },
      cause: error,
    });
  }
}
