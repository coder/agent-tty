import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { ulid } from 'ulid';
import { z } from 'zod';

import {
  captureHost,
  HostRecordSchema,
  judgeHost,
} from '../host/hostRecord.js';
import { CliError } from '../cli/errors.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { ReplaySeqSchema } from '../protocol/schemas.js';
import { readValidatedJsonFile, writeValidatedJsonFile } from './manifests.js';
import {
  createWithoutReplacing,
  publishArtifactFile,
  readRegularFile,
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

// A missing lock throws ENOENT. A lock that is not a regular file (a FIFO,
// a symlink) reads as null, so the caller judges it as an unknown owner.
async function readLockFile(path: string): Promise<string | null> {
  try {
    return (await readRegularFile(path)).toString('utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
    return null;
  }
}

function parseLockOwner(contents: string | null): ManifestLockOwner | null {
  if (contents === null) {
    return null;
  }
  try {
    const parsed = ManifestLockOwnerSchema.safeParse(JSON.parse(contents));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface LockFileState {
  contents: string | null;
  modifiedAtMs: number;
}

async function readLockFileState(path: string): Promise<LockFileState | null> {
  try {
    const contents = await readLockFile(path);
    return { contents, modifiedAtMs: (await lstat(path)).mtimeMs };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

// A clock step can put a modification time in the future, so the age counts
// in both directions.
function isOlderThan(state: LockFileState, limitMs: number): boolean {
  return Math.abs(Date.now() - state.modifiedAtMs) > limitMs;
}

function isStaleLock(
  lockPath: string,
  state: LockFileState,
  timing: ManifestLockTiming,
): boolean {
  if (unreleasedLocks.get(lockPath) === state.contents) {
    return true;
  }
  const owner = parseLockOwner(state.contents);
  // Without a process record the pid may belong to another pid namespace.
  const verdict =
    owner === null || (owner.process === null && process.platform === 'linux')
      ? 'unknown'
      : judgeHost(owner.pid, owner.process);
  return verdict === 'unknown'
    ? isOlderThan(state, timing.unknownOwnerStaleMs)
    : verdict === 'dead';
}

async function removeIfUnchanged(
  path: string,
  contents: string | null,
): Promise<void> {
  const current = await readLockFileState(path);
  if (current !== null && current.contents === contents) {
    await rm(path, { force: true });
  }
}

/**
 * Breakers take `<lock>.break` first, so only one of them can remove the
 * stale lock, and only while it still holds the bytes that were judged.
 */
async function breakStaleManifestLock(
  lockPath: string,
  temporaryPath: string,
  contents: string,
  timing: ManifestLockTiming,
): Promise<'retry' | 'held'> {
  const judged = await readLockFileState(lockPath);
  if (judged === null) {
    return 'retry';
  }
  if (!isStaleLock(lockPath, judged, timing)) {
    return 'held';
  }

  const breakPath = `${lockPath}.break`;
  if (!(await createWithoutReplacing(temporaryPath, breakPath))) {
    const breaker = await readLockFileState(breakPath);
    if (breaker !== null && isOlderThan(breaker, timing.unknownOwnerStaleMs)) {
      await removeIfUnchanged(breakPath, breaker.contents);
    }
    return 'held';
  }
  try {
    await removeIfUnchanged(lockPath, judged.contents);
    if (unreleasedLocks.get(lockPath) === judged.contents) {
      unreleasedLocks.delete(lockPath);
    }
  } finally {
    await removeIfUnchanged(breakPath, contents);
  }
  return 'retry';
}

async function removeOldLockFiles(
  lockPath: string,
  temporaryPath: string,
  timing: ManifestLockTiming,
): Promise<void> {
  const directory = dirname(lockPath);
  const lockName = basename(lockPath);
  const names = await readdir(directory).catch((): string[] => []);
  for (const name of names) {
    const path = join(directory, name);
    if (
      path === temporaryPath ||
      (name !== `${lockName}.break` && !name.startsWith(`${lockName}.tmp-`))
    ) {
      continue;
    }
    const state = await readLockFileState(path).catch(() => null);
    if (state !== null && isOlderThan(state, timing.unknownOwnerStaleMs)) {
      await removeIfUnchanged(path, state.contents).catch(() => undefined);
    }
  }
}

async function acquireManifestLock(
  lockPath: string,
  contents: string,
  timing: ManifestLockTiming,
): Promise<void> {
  const temporaryPath = `${lockPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + timing.waitMs;
    let pollMs = 2;
    for (;;) {
      const now = new Date();
      await utimes(temporaryPath, now, now);
      if (await createWithoutReplacing(temporaryPath, lockPath)) {
        await removeOldLockFiles(lockPath, temporaryPath, timing);
        return;
      }
      const outcome = await breakStaleManifestLock(
        lockPath,
        temporaryPath,
        contents,
        timing,
      );
      if (Date.now() >= deadline) {
        const holder = await readLockFile(lockPath).catch(() => null);
        throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
          message: `Timed out after ${String(timing.waitMs)} ms waiting for the artifact manifest lock at ${lockPath}.`,
          retryable: true,
          details: { lockPath, holderPid: parseLockOwner(holder)?.pid ?? null },
        });
      }
      if (outcome === 'held') {
        await sleep(pollMs);
        pollMs = Math.min(pollMs * 2, MAX_LOCK_POLL_MS);
      }
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
      await removeIfUnchanged(lockPath, contents);
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
    await ensureArtifactsDir(sessionDir);
    await acquireManifestLock(lockPath, contents, timing);
  } catch (error) {
    const removed = await sessionNotFoundIfRemoved(sessionDir, error);
    throw removed instanceof CliError
      ? removed
      : makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
          message: `Failed to take the artifact manifest lock at ${lockPath}.`,
          details: { lockPath },
          cause: error,
        });
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
  /**
   * The append drops the entries whose `metadata.outputPath` names the same
   * file as the entry's: the entry's file replaced theirs. When a later
   * write already replaced the entry's file, the append adds nothing.
   */
  replacesSameOutputPath?: boolean;
}

// Device and inode, so two spellings of one path (a case-insensitive file
// system, a symlink) match. null when the path does not resolve.
async function fileIdentity(path: string): Promise<string | null> {
  try {
    const stats = await stat(path);
    return `${String(stats.dev)}:${String(stats.ino)}`;
  } catch {
    return null;
  }
}

/**
 * Returns the entries to keep beside `entry`, or null when the file at
 * `outputPath` no longer holds the entry's bytes: a later export to the same
 * path replaced it, and that export's entry describes the file.
 */
async function entriesKeptBeside(
  artifacts: readonly ArtifactEntry[],
  entry: ArtifactEntry,
  outputPath: string,
): Promise<ArtifactEntry[] | null> {
  const contents = await readFile(outputPath).catch(() => null);
  if (
    contents === null ||
    createHash('sha256').update(contents).digest('hex') !== entry.sha256
  ) {
    return null;
  }
  const identity = await fileIdentity(outputPath);
  const kept: ArtifactEntry[] = [];
  for (const listed of artifacts) {
    const listedPath = listed.metadata.outputPath;
    if (
      typeof listedPath !== 'string' ||
      (await fileIdentity(listedPath)) !== identity
    ) {
      kept.push(listed);
    }
  }
  return kept;
}

// Removes a rolled-back artifact unless the manifest already lists a file of
// that name, which a repeated default export at the same seq reuses.
async function removeUnlistedArtifact(
  sessionDir: string,
  path: string,
): Promise<void> {
  const listed = await readArtifactManifest(sessionDir).then(
    (manifest) =>
      manifest.artifacts.some((entry) => entry.filename === basename(path)),
    () => false,
  );
  if (!listed) {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

async function appendArtifact(
  sessionDir: string,
  prepare: () => Promise<{
    entry: ArtifactEntry;
    rollbackArtifactPath: string | undefined;
  }>,
  rollbackIfNoLock?: string,
  replacedOutputPath?: string,
): Promise<ArtifactEntry> {
  const resolvedSessionDir = resolve(sessionDir);
  const expectedSessionId = sessionIdFromSessionDir(resolvedSessionDir);
  let locked = false;
  const update = (): Promise<ArtifactEntry> =>
    withArtifactManifestLock(resolvedSessionDir, async () => {
      locked = true;
      const { entry, rollbackArtifactPath } = await prepare();
      try {
        const validatedEntry = validateArtifactEntry(entry, expectedSessionId);
        const manifest = await readArtifactManifest(resolvedSessionDir);
        const kept =
          replacedOutputPath === undefined
            ? manifest.artifacts
            : await entriesKeptBeside(
                manifest.artifacts,
                validatedEntry,
                replacedOutputPath,
              );
        if (kept === null) {
          return validatedEntry;
        }
        await writeArtifactManifest(resolvedSessionDir, {
          ...manifest,
          artifacts: [...kept, validatedEntry],
        });
        return validatedEntry;
      } catch (error) {
        if (rollbackArtifactPath !== undefined) {
          await removeUnlistedArtifact(
            resolvedSessionDir,
            rollbackArtifactPath,
          );
        }
        throw error;
      }
    });
  return await appendSerializer.run(resolvedSessionDir, async () => {
    try {
      return await update();
    } catch (error) {
      if (!locked && rollbackIfNoLock !== undefined) {
        await removeUnlistedArtifact(resolvedSessionDir, rollbackIfNoLock);
      }
      throw error;
    }
  });
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

  let replacedOutputPath: string | undefined;
  if (options.replacesSameOutputPath === true) {
    const outputPath = options.entry.metadata.outputPath;
    invariant(
      typeof outputPath === 'string' && isAbsolute(outputPath),
      'an entry that replaces its output path must name an absolute metadata.outputPath',
    );
    invariant(
      options.entry.sha256 !== undefined,
      'an entry that replaces its output path must have a sha256',
    );
    replacedOutputPath = outputPath;
  }

  await appendArtifact(
    options.sessionDir,
    () =>
      Promise.resolve({
        entry: options.entry,
        rollbackArtifactPath: options.rollbackArtifactPath,
      }),
    options.rollbackArtifactPath,
    replacedOutputPath,
  );
}

export interface RemoveArtifactEntryOptions {
  sessionDir: string;
  filename: string;
  sha256: string;
}

/**
 * Undoes a capture: removes the last manifest entry with `filename` and
 * `sha256`, then the file when no other entry lists it. It runs in the same
 * per-session queue and lock as the appends.
 */
export async function removeArtifactEntry(
  options: RemoveArtifactEntryOptions,
): Promise<void> {
  const resolvedSessionDir = resolve(options.sessionDir);
  const path = artifactPath(resolvedSessionDir, options.filename);
  await appendSerializer.run(resolvedSessionDir, () =>
    withArtifactManifestLock(resolvedSessionDir, async () => {
      const manifest = await readArtifactManifest(resolvedSessionDir);
      const index = manifest.artifacts.findLastIndex(
        (entry) =>
          entry.filename === options.filename &&
          entry.sha256 === options.sha256,
      );
      if (index === -1) {
        return;
      }
      const artifacts = manifest.artifacts.toSpliced(index, 1);
      await writeArtifactManifest(resolvedSessionDir, {
        ...manifest,
        artifacts,
      });
      if (!artifacts.some((entry) => entry.filename === options.filename)) {
        await rm(path, { force: true });
      }
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
