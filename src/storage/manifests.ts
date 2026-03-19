import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import {
  ERROR_CODES,
  makeCliError,
} from '../protocol/errors.js';
import {
  SessionRecordSchema,
} from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';
import type { SessionRecord } from '../protocol/schemas.js';

interface NodeError {
  code?: string;
}

function assertAbsoluteManifestPath(path: string): void {
  invariant(path.length > 0, 'manifest path must be a non-empty string');
  invariant(isAbsolute(path), 'manifest path must be absolute');
}

function isEnoentError(error: unknown): error is Error & NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeError).code === 'ENOENT'
  );
}

function validateManifestData(
  path: string,
  data: unknown,
): SessionRecord {
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

function parseManifestJson(path: string, rawManifest: string): SessionRecord {
  try {
    return validateManifestData(path, JSON.parse(rawManifest) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
        message: `Session manifest contains invalid JSON at ${path}.`,
        details: { path },
        cause: error,
      });
    }

    throw error;
  }
}

async function readManifestInternal(
  path: string,
  allowMissing: boolean,
): Promise<SessionRecord | null> {
  assertAbsoluteManifestPath(path);

  let rawManifest: string;
  try {
    rawManifest = await readFile(path, 'utf8');
  } catch (error) {
    if (allowMissing && isEnoentError(error)) {
      return null;
    }

    throw makeCliError(ERROR_CODES.STORAGE_READ_ERROR, {
      message: `Failed to read session manifest at ${path}.`,
      details: { path },
      cause: error,
    });
  }

  return parseManifestJson(path, rawManifest);
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
  assertAbsoluteManifestPath(path);

  const validatedRecord = validateManifestData(path, record);
  const serializedManifest = `${JSON.stringify(validatedRecord, null, 2)}\n`;
  const manifestDirectory = dirname(path);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;

  try {
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(temporaryPath, serializedManifest, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: `Failed to write session manifest at ${path}.`,
      details: { path },
      cause: error,
    });
  }
}
