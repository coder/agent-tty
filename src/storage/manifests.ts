import { randomUUID } from 'node:crypto';
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
}

export interface WriteTextFileAtomicOptions {
  path: string;
  pathLabel: string;
  contents: string;
  writeErrorMessage: string;
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

export async function writeTextFileAtomic(
  options: WriteTextFileAtomicOptions,
): Promise<void> {
  assertAbsoluteStoragePath(options.path, options.pathLabel);

  const outputDirectory = dirname(options.path);
  const temporaryPath = `${options.path}.tmp-${randomUUID()}`;

  try {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(temporaryPath, options.contents, 'utf8');
    await rename(temporaryPath, options.path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
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
  });
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
  await writeValidatedJsonFile({
    path,
    pathLabel: 'manifest path',
    data: record,
    writeErrorMessage: `Failed to write session manifest at ${path}.`,
    validate: validateManifestData,
  });
}
