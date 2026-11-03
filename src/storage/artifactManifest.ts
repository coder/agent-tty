import { randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { ulid } from 'ulid';
import { z } from 'zod';

import {
  captureHost,
  HostRecordSchema,
  judgeHost,
} from '../host/hostRecord.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { ReplaySeqSchema } from '../protocol/schemas.js';
import { readValidatedJsonFile, writeValidatedJsonFile } from './manifests.js';
import {
  createWithoutReplacing,
  publishArtifactFile,
} from './artifactFiles.js';
import {
  artifactPath,
  ensureArtifactsDir,
  sessionNotFoundIfRemoved,
} from './artifactPaths.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';
import { KeyedSerializer } from '../util/keyedSerializer.js';

const ARTIFACT_MANIFEST_FILENAME = 'manifest.json';
const ARTIFACT_MANIFEST_LOCK_FILENAME = 'manifest.json.lock';
const MAX_LOCK_POLL_MS = 50;
const MAX_LOCK_RELEASE_ATTEMPTS = 3;
const NonEmptyStringSchema = z.string().min(1);
const IsoDatetimeSchema = z.iso.datetime();
const ArtifactKindSchema = z.enum([
  'screenshot',
  'snapshot',
  'recording',
  'video',
]);

export const ArtifactEntrySchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: ArtifactKindSchema,
    filename: NonEmptyStringSchema.refine(
      (value) => !value.includes('/') && !value.includes('\\'),
      'filename must not contain path separators',
    ),
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: ReplaySeqSchema,
    createdAt: IsoDatetimeSchema,
    sha256: z
      .string()
      .regex(
        /^[a-f0-9]{64}$/,
        'sha256 must be a 64-character lowercase hex string',
      )
      .optional(),
    bytes: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const ArtifactManifestSchema = z
  .object({
    version: z.literal(1),
    sessionId: NonEmptyStringSchema,
    artifacts: z.array(ArtifactEntrySchema),
  })
  .strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

const ManifestLockOwnerSchema = z
  .object({
    version: z.literal(1),
    token: NonEmptyStringSchema,
    pid: z.number().int().positive(),
    process: HostRecordSchema.nullable(),
  })
  .strict();

export interface ManifestLockTiming {
  waitMs: number;
  unknownOwnerStaleMs: number;
}

const DEFAULT_MANIFEST_LOCK_TIMING: ManifestLockTiming = {
  waitMs: 10_000,
  unknownOwnerStaleMs: 60_000,
};

const appendSerializer = new KeyedSerializer<string>();
// Locks this process took but could not remove, by lock path. The next
// acquisition in this process breaks such a lock instead of waiting for it.
const unreleasedLocks = new Map<string, string>();

function artifactManifestPath(sessionDir: string): string {
  return artifactPath(sessionDir, ARTIFACT_MANIFEST_FILENAME);
}

function sessionIdFromSessionDir(sessionDir: string): string {
  const sessionId = basename(resolve(sessionDir));
  invariant(
    sessionId.length > 0,
    'sessionDir must resolve to a non-empty sessionId',
  );
  return sessionId;
}

function validateArtifactManifestData(
  path: string,
  data: unknown,
  expectedSessionId: string,
): ArtifactManifest {
  const parsedManifest = ArtifactManifestSchema.safeParse(data);

  if (!parsedManifest.success) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact manifest validation failed for ${path}.`,
      details: {
        path,
        issues: parsedManifest.error.issues,
      },
    });
  }

  if (parsedManifest.data.sessionId !== expectedSessionId) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact manifest sessionId mismatch for ${path}.`,
      details: {
        path,
        expectedSessionId,
        actualSessionId: parsedManifest.data.sessionId,
      },
    });
  }

  return parsedManifest.data;
}

function validateArtifactEntry(
  entry: ArtifactEntry,
  expectedSessionId: string,
): ArtifactEntry {
  const parsedEntry = ArtifactEntrySchema.safeParse(entry);

  if (!parsedEntry.success) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact entry validation failed for session ${expectedSessionId}.`,
      details: {
        sessionId: expectedSessionId,
        issues: parsedEntry.error.issues,
      },
    });
  }

  if (parsedEntry.data.sessionId !== expectedSessionId) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact entry sessionId mismatch for session ${expectedSessionId}.`,
      details: {
        expectedSessionId,
        actualSessionId: parsedEntry.data.sessionId,
      },
    });
  }

  return parsedEntry.data;
}

function emptyArtifactManifest(sessionDir: string): ArtifactManifest {
  return {
    version: 1,
    sessionId: sessionIdFromSessionDir(sessionDir),
    artifacts: [],
  };
}

export async function readArtifactManifest(
  sessionDir: string,
): Promise<ArtifactManifest> {
  const path = artifactManifestPath(sessionDir);
  const expectedSessionId = sessionIdFromSessionDir(sessionDir);
  const manifest = await readValidatedJsonFile({
    path,
    pathLabel: 'artifact manifest path',
    allowMissing: true,
    readErrorMessage: `Failed to read artifact manifest at ${path}.`,
    invalidJsonMessage: `Artifact manifest contains invalid JSON at ${path}.`,
    validate: (manifestPath, data) =>
      validateArtifactManifestData(manifestPath, data, expectedSessionId),
  });

  return manifest ?? emptyArtifactManifest(sessionDir);
}

export async function writeArtifactManifest(
  sessionDir: string,
  manifest: ArtifactManifest,
): Promise<void> {
  const path = artifactManifestPath(sessionDir);
  const expectedSessionId = sessionIdFromSessionDir(sessionDir);

  await ensureArtifactsDir(sessionDir);
  await writeValidatedJsonFile({
    path,
    pathLabel: 'artifact manifest path',
    data: manifest,
    writeErrorMessage: `Failed to write artifact manifest at ${path}.`,
    validate: (manifestPath, data) =>
      validateArtifactManifestData(manifestPath, data, expectedSessionId),
    createParentFolders: false,
  });
}

type ManifestLockOwner = z.infer<typeof ManifestLockOwnerSchema>;

function parseLockOwner(contents: string): ManifestLockOwner | null {
  try {
    const parsed = ManifestLockOwnerSchema.safeParse(JSON.parse(contents));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function breakStaleManifestLock(
  lockPath: string,
  timing: ManifestLockTiming,
): Promise<'retry' | 'held'> {
  let observed: string;
  let modifiedAtMs: number;
  try {
    observed = await readFile(lockPath, 'utf8');
    modifiedAtMs = (await lstat(lockPath)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return 'retry';
    }
    throw error;
  }

  const owner = parseLockOwner(observed);
  const verdict =
    owner === null ? 'unknown' : judgeHost(owner.pid, owner.process);
  const stale =
    unreleasedLocks.get(lockPath) === observed ||
    (verdict === 'unknown'
      ? Date.now() - modifiedAtMs > timing.unknownOwnerStaleMs
      : verdict === 'dead');
  if (!stale) {
    return 'held';
  }

  const movedPath = `${lockPath}.broken-${randomUUID()}`;
  try {
    await rename(lockPath, movedPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return 'retry';
    }
    throw error;
  }
  try {
    const moved = await readFile(movedPath, 'utf8');
    if (moved === unreleasedLocks.get(lockPath)) {
      unreleasedLocks.delete(lockPath);
    }
    if (moved !== observed) {
      await createWithoutReplacing(movedPath, lockPath);
    }
  } finally {
    await rm(movedPath, { force: true });
  }
  return 'retry';
}

async function acquireManifestLock(
  lockPath: string,
  contents: string,
  timing: ManifestLockTiming,
): Promise<void> {
  const temporaryPath = `${lockPath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
  try {
    const deadline = Date.now() + timing.waitMs;
    let pollMs = 2;
    for (;;) {
      const now = new Date();
      await utimes(temporaryPath, now, now);
      if (await createWithoutReplacing(temporaryPath, lockPath)) {
        return;
      }
      if ((await breakStaleManifestLock(lockPath, timing)) === 'retry') {
        continue;
      }
      if (Date.now() >= deadline) {
        const holder = await readFile(lockPath, 'utf8').catch(() => '');
        throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
          message: `Timed out after ${String(timing.waitMs)} ms waiting for the artifact manifest lock at ${lockPath}.`,
          retryable: true,
          details: { lockPath, holderPid: parseLockOwner(holder)?.pid ?? null },
        });
      }
      await sleep(pollMs);
      pollMs = Math.min(pollMs * 2, MAX_LOCK_POLL_MS);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function releaseManifestLock(
  lockPath: string,
  contents: string,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const current = await readFile(lockPath, 'utf8').catch(
        (error: unknown) => {
          if (hasErrorCode(error, 'ENOENT')) {
            return null;
          }
          throw error;
        },
      );
      if (current === contents) {
        await rm(lockPath, { force: true });
      }
      return;
    } catch {
      if (attempt >= MAX_LOCK_RELEASE_ATTEMPTS) {
        unreleasedLocks.set(lockPath, contents);
        return;
      }
      await sleep(10 * attempt);
    }
  }
}

/**
 * Runs `update` while this process holds `<sessionDir>/artifacts/manifest.json.lock`,
 * so manifest updates from the host and from CLI processes do not overwrite
 * each other. The lock file names its owner's pid and process identity.
 */
export async function withArtifactManifestLock<T>(
  sessionDir: string,
  update: () => Promise<T>,
  timing: ManifestLockTiming = DEFAULT_MANIFEST_LOCK_TIMING,
): Promise<T> {
  invariant(timing.waitMs >= 0, 'lock waitMs must not be negative');
  invariant(
    timing.unknownOwnerStaleMs >= 0,
    'lock unknownOwnerStaleMs must not be negative',
  );
  await ensureArtifactsDir(sessionDir);
  const lockPath = artifactPath(sessionDir, ARTIFACT_MANIFEST_LOCK_FILENAME);
  const contents = JSON.stringify(
    ManifestLockOwnerSchema.parse({
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      process: captureHost(process.pid),
    }),
  );

  try {
    await acquireManifestLock(lockPath, contents, timing);
  } catch (error) {
    throw await sessionNotFoundIfRemoved(sessionDir, error);
  }
  try {
    return await update();
  } finally {
    await releaseManifestLock(lockPath, contents);
  }
}

export interface AppendArtifactWithRollbackOptions {
  sessionDir: string;
  entry: ArtifactEntry;
  rollbackArtifactPath?: string;
}

async function appendArtifact(
  sessionDir: string,
  prepare: () => Promise<{
    entry: ArtifactEntry;
    rollbackArtifactPath: string | undefined;
  }>,
): Promise<ArtifactEntry> {
  const resolvedSessionDir = resolve(sessionDir);
  const expectedSessionId = sessionIdFromSessionDir(resolvedSessionDir);
  return await appendSerializer.run(resolvedSessionDir, () =>
    withArtifactManifestLock(resolvedSessionDir, async () => {
      const { entry, rollbackArtifactPath } = await prepare();
      try {
        const validatedEntry = validateArtifactEntry(entry, expectedSessionId);
        const manifest = await readArtifactManifest(resolvedSessionDir);
        await writeArtifactManifest(resolvedSessionDir, {
          ...manifest,
          artifacts: [...manifest.artifacts, validatedEntry],
        });
        return validatedEntry;
      } catch (error) {
        if (rollbackArtifactPath !== undefined) {
          // Best-effort: swallow rm errors so the original manifest failure propagates.
          await rm(rollbackArtifactPath, { force: true }).catch(
            () => undefined,
          );
        }
        throw error;
      }
    }),
  );
}

/**
 * Append an artifact entry to the session manifest, removing the artifact file
 * at `rollbackArtifactPath` if the append fails. Rollback is best-effort: rm
 * errors are swallowed so the original manifest error propagates.
 */
export async function appendArtifactWithRollback(
  options: AppendArtifactWithRollbackOptions,
): Promise<void> {
  if (options.rollbackArtifactPath !== undefined) {
    invariant(
      options.rollbackArtifactPath.length > 0,
      'rollbackArtifactPath must be a non-empty string',
    );
    invariant(
      isAbsolute(options.rollbackArtifactPath),
      'rollbackArtifactPath must be absolute',
    );
  }

  await appendArtifact(options.sessionDir, () =>
    Promise.resolve({
      entry: options.entry,
      rollbackArtifactPath: options.rollbackArtifactPath,
    }),
  );
}

export interface PublishArtifactWithRollbackOptions {
  sessionDir: string;
  temporaryPath: string;
  /** `entry.filename` is the preferred name. */
  entry: ArtifactEntry;
}

/**
 * Publish `temporaryPath` with `publishArtifactFile` and append `entry` under
 * the published name. Publishing runs in the same per-session queue as the
 * append, so a failed append cannot remove a file that another capture reused
 * in between. A failed append removes the file only when this call created
 * it. The temporary file is always removed. Returns the recorded entry.
 */
export async function publishArtifactWithRollback(
  options: PublishArtifactWithRollbackOptions,
): Promise<ArtifactEntry> {
  try {
    return await appendArtifact(options.sessionDir, async () => {
      const published = await publishArtifactFile({
        sessionDir: options.sessionDir,
        temporaryPath: options.temporaryPath,
        filename: options.entry.filename,
      });
      return {
        entry: { ...options.entry, filename: published.filename },
        rollbackArtifactPath: published.created ? published.path : undefined,
      };
    });
  } finally {
    await rm(options.temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function createArtifactEntry(
  entry: Omit<ArtifactEntry, 'id' | 'createdAt'>,
): ArtifactEntry {
  return {
    ...entry,
    id: ulid(),
    createdAt: new Date().toISOString(),
  };
}
