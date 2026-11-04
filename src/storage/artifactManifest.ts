import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  rm,
  rmdir,
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
// A breaker that met another waits this long times 2^(meetings - 1), up
// to MAX_MEETING_BACKOFF_MS, with jitter.
const MEETING_BACKOFF_MS = 5;
const MAX_MEETING_BACKOFF_MS = 200;
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

// The lock, break and temp files hold their writer's record. Their owner is
// gone when judgeHost says it is dead, or when it reads unknown and the file
// is older than unknownOwnerStaleMs.
function isOwnerGone(
  state: LockFileState,
  timing: ManifestLockTiming,
): boolean {
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

// A break file is a lease: it also expires after unknownOwnerStaleMs while
// its breaker lives, so a stopped breaker cannot block every writer.
function isStaleBreakFile(
  state: LockFileState,
  timing: ManifestLockTiming,
): boolean {
  return (
    isOwnerGone(state, timing) || isOlderThan(state, timing.unknownOwnerStaleMs)
  );
}

function isStaleLock(
  lockPath: string,
  state: LockFileState,
  timing: ManifestLockTiming,
): boolean {
  return (
    unreleasedLocks.get(lockPath) === state.contents ||
    isOwnerGone(state, timing)
  );
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

// Breakers announce themselves in their own folder, so listing them costs
// nothing however many artifacts the session holds.
function announcementFolder(lockPath: string): string {
  return `${lockPath}.breakers`;
}

// Returns true when another breaker that is not stale announced itself.
// It removes the announcements of stale breakers on the way. Each has a
// name that no other writer uses, so removing it by path cannot remove a
// live breaker's announcement.
async function otherBreakerAnnounced(
  lockPath: string,
  announcementPath: string,
  timing: ManifestLockTiming,
): Promise<boolean> {
  const folder = announcementFolder(lockPath);
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    if (path === announcementPath) {
      continue;
    }
    const state = await readLockFileState(path);
    if (state === null) {
      continue;
    }
    if (!isStaleBreakFile(state, timing)) {
      return true;
    }
    await removeIfUnchanged(path, state.contents);
  }
  return false;
}

/**
 * A breaker first announces itself with `<lock>.breakers/<id>` and acts only
 * when no other live breaker announced, so breakers act one at a time: of
 * two that announce, the one that scans later sees the other. The acting
 * breaker takes `<lock>.break` the same exclusive way, which also keeps out
 * older agent-tty versions, and removes the stale lock only while it still
 * holds the bytes that were judged.
 */
async function breakStaleManifestLock(
  lockPath: string,
  temporaryPath: string,
  announcementPath: string,
  contents: string,
  timing: ManifestLockTiming,
): Promise<'retry' | 'held' | 'met'> {
  const judged = await readLockFileState(lockPath);
  if (judged === null) {
    return 'retry';
  }
  if (!isStaleLock(lockPath, judged, timing)) {
    return 'held';
  }

  // mkdir without recursive, so a removed session folder stays removed.
  const folder = announcementFolder(lockPath);
  await mkdir(folder).catch((error: unknown) => {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  });
  try {
    // The name is this writer's own, so it can already exist only from this
    // writer's earlier attempt.
    await createWithoutReplacing(temporaryPath, announcementPath);
  } catch (error) {
    // Another breaker removed the empty folder after the mkdir. The next
    // attempt makes it again.
    if (hasErrorCode(error, 'ENOENT')) {
      return 'held';
    }
    throw error;
  }
  try {
    if (await otherBreakerAnnounced(lockPath, announcementPath, timing)) {
      return 'met';
    }
    const breakPath = `${lockPath}.break`;
    if (!(await createWithoutReplacing(temporaryPath, breakPath))) {
      const breaker = await readLockFileState(breakPath);
      if (breaker !== null && isStaleBreakFile(breaker, timing)) {
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
  } finally {
    await rm(announcementPath, { force: true });
    // rmdir removes only an empty folder, so no announcement goes with it.
    await rmdir(folder).catch(() => undefined);
  }
}

async function removeOldLockFiles(
  lockPath: string,
  temporaryPath: string,
  timing: ManifestLockTiming,
): Promise<void> {
  const directory = dirname(lockPath);
  const lockName = basename(lockPath);
  const folder = announcementFolder(lockPath);
  const paths = [
    ...(await readdir(directory).catch((): string[] => []))
      .filter(
        (name) =>
          name === `${lockName}.break` || name.startsWith(`${lockName}.tmp-`),
      )
      .map((name) => join(directory, name)),
    ...(await readdir(folder).catch((): string[] => [])).map((name) =>
      join(folder, name),
    ),
  ];
  for (const path of paths) {
    if (path === temporaryPath) {
      continue;
    }
    const breakFile = !basename(path).startsWith(`${lockName}.tmp-`);
    const state = await readLockFileState(path).catch(() => null);
    if (state === null) {
      continue;
    }
    const stale = breakFile
      ? isStaleBreakFile(state, timing)
      : isOwnerGone(state, timing);
    if (stale) {
      await removeIfUnchanged(path, state.contents).catch(() => undefined);
    }
  }
  await rmdir(folder).catch(() => undefined);
}

// A writer stopped for over unknownOwnerStaleMs while it waits can find that
// another writer removed its temp file, so it writes the file again.
async function refreshTemporaryFile(
  path: string,
  contents: string,
): Promise<void> {
  const now = new Date();
  try {
    await utimes(path, now, now);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
    await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  }
}

async function acquireManifestLock(
  lockPath: string,
  contents: string,
  timing: ManifestLockTiming,
): Promise<void> {
  const id = randomUUID();
  const temporaryPath = `${lockPath}.tmp-${id}`;
  const announcementPath = join(announcementFolder(lockPath), id);
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + timing.waitMs;
    let pollMs = 2;
    let meetings = 0;
    let foundTaken = false;
    for (;;) {
      await refreshTemporaryFile(temporaryPath, contents);
      if (await createWithoutReplacing(temporaryPath, lockPath)) {
        // Writers that die while they wait for or hold the lock leave lock
        // files behind. Only a writer that found the lock taken scans the
        // artifacts folder for them, so a free lock costs no scan.
        if (foundTaken) {
          await removeOldLockFiles(lockPath, temporaryPath, timing);
        }
        return;
      }
      foundTaken = true;
      // The check comes right after a failed link: a writer stopped past
      // its deadline inside the break attempt still tries the link once.
      if (Date.now() >= deadline) {
        const holder = await readLockFile(lockPath).catch(() => null);
        throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
          message: `Timed out after ${String(timing.waitMs)} ms waiting for the artifact manifest lock at ${lockPath}.`,
          retryable: true,
          details: { lockPath, holderPid: parseLockOwner(holder)?.pid ?? null },
        });
      }
      const outcome = await breakStaleManifestLock(
        lockPath,
        temporaryPath,
        announcementPath,
        contents,
        timing,
      );
      if (outcome === 'met') {
        // Breakers that saw each other all wait. Each meeting doubles the
        // wait, and the jitter spreads their next attempts apart.
        meetings += 1;
        const backoffMs = Math.min(
          MEETING_BACKOFF_MS * 2 ** (meetings - 1),
          MAX_MEETING_BACKOFF_MS,
        );
        await sleep(backoffMs * (0.5 + Math.random()));
      } else if (outcome === 'held') {
        await sleep(pollMs * (0.5 + Math.random()));
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
   * `fileIdentity` of the file that the entry describes, taken when it was
   * written. The append then drops the entries whose `metadata.outputPath`
   * names that file, which replaced theirs. When `metadata.outputPath` no
   * longer names that file, the append drops nothing and still adds the
   * entry, unless the path now holds a file of another size.
   */
  outputFileIdentity?: string;
}

/**
 * Device, inode, size and modification time of the file at `path`, so two
 * spellings of one path (a case-insensitive file system, a symlink) match.
 * A rename keeps all four. Size and time keep a later file that reuses a
 * removed file's inode number from matching it. null when the path does
 * not resolve.
 */
export async function fileIdentity(path: string): Promise<string | null> {
  try {
    // bigint keeps the numbers above 2^53 exact and the time in nanoseconds.
    const stats = await stat(path, { bigint: true });
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs].join(':');
  } catch {
    return null;
  }
}

function pathSpelling(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

// The size field of a fileIdentity string.
function identitySize(identity: string): string {
  const fields = identity.split(':');
  invariant(fields.length === 4, 'a file identity has four fields');
  return fields[2] ?? '';
}

/**
 * Returns the entries to keep beside an entry for the file `identity` at
 * `outputPath`, or null when the entry must not be added. When `outputPath`
 * no longer names that file but holds a file of the same size, or no file,
 * it keeps them all: a file server or a tool can have changed the time, and
 * an entry too many is better than a lost one. A file of another size holds
 * other bytes, which a later export or a tool that rewrote the file left, so
 * the entry would describe bytes that are gone: it returns null.
 */
async function entriesKeptBeside(
  artifacts: readonly ArtifactEntry[],
  outputPath: string,
  identity: string,
): Promise<readonly ArtifactEntry[] | null> {
  const current = await fileIdentity(outputPath);
  if (current !== identity) {
    return current !== null && identitySize(current) !== identitySize(identity)
      ? null
      : artifacts;
  }
  // Only a path that differs at most in case can name the same file, so the
  // append reads no other entry's path, which can be on a slow mount.
  const spelling = pathSpelling(outputPath);
  const kept: ArtifactEntry[] = [];
  for (const listed of artifacts) {
    const listedPath = listed.metadata.outputPath;
    const sameFile =
      typeof listedPath === 'string' &&
      pathSpelling(listedPath) === spelling &&
      (await fileIdentity(listedPath)) === identity;
    if (!sameFile) {
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
  replacedOutput?: { path: string; identity: string },
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
          replacedOutput === undefined
            ? manifest.artifacts
            : await entriesKeptBeside(
                manifest.artifacts,
                replacedOutput.path,
                replacedOutput.identity,
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

  let replacedOutput: { path: string; identity: string } | undefined;
  if (options.outputFileIdentity !== undefined) {
    const outputPath = options.entry.metadata.outputPath;
    invariant(
      typeof outputPath === 'string' && isAbsolute(outputPath),
      'an entry with an outputFileIdentity must name an absolute metadata.outputPath',
    );
    replacedOutput = { path: outputPath, identity: options.outputFileIdentity };
  }

  await appendArtifact(
    options.sessionDir,
    () =>
      Promise.resolve({
        entry: options.entry,
        rollbackArtifactPath: options.rollbackArtifactPath,
      }),
    options.rollbackArtifactPath,
    replacedOutput,
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
