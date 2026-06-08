import { readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { reconcileSession } from '../../host/lifecycle.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import {
  isCollectableSessionStatus,
  isTerminalSessionStatus,
} from '../../protocol/sessionStatusPolicy.js';
import type { SessionRecord } from '../../protocol/schemas.js';
import {
  forgetHome as forgetHomeDefault,
  readHomeRegistry,
} from '../../storage/homeRegistry.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { manifestPath, sessionDir } from '../../storage/sessionPaths.js';
import { invariant } from '../../util/assert.js';
import { hasErrorCode } from '../../util/hasErrorCode.js';

/** Per-Home collection result returned by `gcSessions`. */
export interface GcSessionSweep {
  removedSessions: string[];
  skippedSessions: Array<{
    sessionId: string;
    reason: string;
  }>;
  dryRun: boolean;
  totalBytesFreed: number;
}

/** What gc did to a single Home during a (possibly cross-Home) run. */
export interface GcHomeOutcome {
  home: string;
  /** Whether the Home directory existed at sweep time. */
  existed: boolean;
  removedSessions: string[];
  skippedSessions: Array<{
    sessionId: string;
    reason: string;
  }>;
  totalBytesFreed: number;
  /** Whether the Home was deregistered from the Home Registry this run (or
   * would be, under --dry-run). Only ever true for a cross-Home sweep. */
  deregistered: boolean;
}

/** Command-level result emitted by `gc`. Always cross-Home shaped, even when
 * scoped to a single Home via --home/AGENT_TTY_HOME (then `homes` has one
 * entry). */
export interface GcResult {
  dryRun: boolean;
  homes: GcHomeOutcome[];
  removedSessionCount: number;
  totalBytesFreed: number;
  deregisteredHomes: string[];
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  dryRun: boolean;
  staleOnly: boolean;
  olderThan: string | undefined;
}

export interface GcExecutionOptions {
  dryRun: boolean;
  staleOnly: boolean;
  olderThanMs: number | null;
}

export interface GcDependencies {
  readdir: (path: string) => Promise<string[]>;
  stat: (path: string) => Promise<{
    size: number;
    isDirectory: () => boolean;
  }>;
  rm: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
  readManifestIfExists: (path: string) => Promise<SessionRecord | null>;
  reconcileSession: (sessionDirectory: string) => Promise<void>;
  now: () => Date;
}

const defaultDependencies: GcDependencies = {
  readdir,
  stat,
  rm,
  readManifestIfExists,
  reconcileSession,
  now: () => new Date(),
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function makeInvalidDurationError(value: string) {
  return makeCliError(ERROR_CODES.INVALID_DURATION, {
    message: `Invalid duration value: ${value}`,
    details: {
      value,
      expectedFormat: 'positive integer followed by m, h, or d',
    },
  });
}

function getSessionsRoot(home: string): string {
  invariant(
    typeof home === 'string' && home.length > 0,
    'home must not be empty',
  );
  return resolve(home, 'sessions');
}

async function readSessionEntries(
  home: string,
  dependencies: GcDependencies,
): Promise<string[]> {
  const sessionsRoot = getSessionsRoot(home);

  try {
    return await dependencies.readdir(sessionsRoot);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }

    throw makeCliError(ERROR_CODES.STORAGE_READ_ERROR, {
      message: `Failed to read sessions directory at ${sessionsRoot}.`,
      details: {
        sessionsRoot,
      },
      cause: error,
    });
  }
}

async function measurePathBytes(
  targetPath: string,
  dependencies: Pick<GcDependencies, 'readdir' | 'stat'>,
): Promise<number> {
  const stats = await dependencies.stat(targetPath);
  let totalBytes = stats.size;

  if (!stats.isDirectory()) {
    return totalBytes;
  }

  const childEntries = await dependencies.readdir(targetPath);
  for (const childEntry of childEntries) {
    totalBytes += await measurePathBytes(
      resolve(targetPath, childEntry),
      dependencies,
    );
  }

  return totalBytes;
}

function wasReconciledFromStaleHost(
  manifestBefore: SessionRecord,
  manifestAfter: SessionRecord,
): boolean {
  return (
    !isTerminalSessionStatus(manifestBefore.status) &&
    isTerminalSessionStatus(manifestAfter.status)
  );
}

function shouldSkipForAge(
  manifest: SessionRecord,
  olderThanMs: number | null,
  now: Date,
): boolean {
  if (olderThanMs === null) {
    return false;
  }

  const createdAtMs = Date.parse(manifest.createdAt);
  invariant(
    Number.isFinite(createdAtMs),
    'manifest.createdAt must be valid ISO',
  );

  return now.getTime() - createdAtMs < olderThanMs;
}

function buildGcLines(result: GcResult): string[] {
  const lines: string[] = [];
  const actionLabel = result.dryRun ? 'Would remove' : 'Removed';
  const bytesLabel = result.dryRun
    ? 'Estimated bytes reclaimable'
    : 'Estimated bytes freed';

  lines.push(
    `${actionLabel} ${String(result.removedSessionCount)} session(s) across ${String(result.homes.length)} home(s).`,
  );
  lines.push(`${bytesLabel}: ${String(result.totalBytesFreed)}`);

  for (const home of result.homes) {
    const hasActivity =
      home.removedSessions.length > 0 ||
      home.skippedSessions.length > 0 ||
      home.deregistered;
    if (!hasActivity) {
      continue;
    }

    lines.push(`${home.home}:`);
    for (const sessionId of home.removedSessions) {
      lines.push(`  - removed ${sessionId}`);
    }
    for (const skippedSession of home.skippedSessions) {
      lines.push(
        `  - skipped ${skippedSession.sessionId}: ${skippedSession.reason}`,
      );
    }
    if (home.deregistered) {
      lines.push(
        result.dryRun
          ? '  - would deregister (no sessions left)'
          : '  - deregistered (no sessions left)',
      );
    }
  }

  if (
    result.removedSessionCount === 0 &&
    result.deregisteredHomes.length === 0 &&
    result.homes.every((home) => home.skippedSessions.length === 0)
  ) {
    lines.push('Nothing to collect.');
  }

  return lines;
}

export function parseDurationToMs(value: string): number {
  invariant(typeof value === 'string', 'duration value must be a string');

  const trimmedValue = value.trim();
  const match = /^([1-9]\d*)([mhd])$/.exec(trimmedValue);

  if (match === null) {
    throw makeInvalidDurationError(value);
  }

  const magnitudeText = match[1];
  const unit = match[2];
  invariant(typeof magnitudeText === 'string', 'duration magnitude must exist');
  invariant(typeof unit === 'string', 'duration unit must exist');

  const magnitude = Number.parseInt(magnitudeText, 10);
  invariant(Number.isSafeInteger(magnitude), 'duration magnitude must be safe');
  const unitMultiplierMs =
    unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const durationMs = magnitude * unitMultiplierMs;

  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw makeInvalidDurationError(value);
  }

  return durationMs;
}

export async function gcSessions(
  home: string,
  options: GcExecutionOptions,
  dependencies: GcDependencies = defaultDependencies,
): Promise<GcSessionSweep> {
  invariant(
    typeof home === 'string' && home.length > 0,
    'home must not be empty',
  );
  invariant(typeof options.dryRun === 'boolean', 'dryRun must be boolean');
  invariant(
    typeof options.staleOnly === 'boolean',
    'staleOnly must be boolean',
  );
  invariant(
    options.olderThanMs === null ||
      (Number.isInteger(options.olderThanMs) && options.olderThanMs > 0),
    'olderThanMs must be null or a positive integer',
  );

  const now = dependencies.now();
  invariant(now instanceof Date, 'now() must return a Date');
  invariant(Number.isFinite(now.getTime()), 'now() must return a valid Date');

  const result: GcSessionSweep = {
    removedSessions: [],
    skippedSessions: [],
    dryRun: options.dryRun,
    totalBytesFreed: 0,
  };
  const sessionEntries = await readSessionEntries(home, dependencies);

  for (const entry of sessionEntries) {
    const sessionDirectory = sessionDir(home, entry);
    const manifestFile = manifestPath(sessionDirectory);

    let sessionStats: Awaited<ReturnType<GcDependencies['stat']>>;
    try {
      sessionStats = await dependencies.stat(sessionDirectory);
    } catch (error) {
      result.skippedSessions.push({
        sessionId: entry,
        reason: hasErrorCode(error, 'ENOENT')
          ? 'session directory no longer exists'
          : `failed to stat session directory: ${getErrorMessage(error)}`,
      });
      continue;
    }

    if (!sessionStats.isDirectory()) {
      result.skippedSessions.push({
        sessionId: entry,
        reason: 'entry is not a session directory',
      });
      continue;
    }

    let manifestBefore: SessionRecord | null;
    try {
      manifestBefore = await dependencies.readManifestIfExists(manifestFile);
    } catch (error) {
      result.skippedSessions.push({
        sessionId: entry,
        reason: `failed to read manifest: ${getErrorMessage(error)}`,
      });
      continue;
    }

    if (manifestBefore === null) {
      result.skippedSessions.push({
        sessionId: entry,
        reason: 'session manifest is missing',
      });
      continue;
    }

    try {
      await dependencies.reconcileSession(sessionDirectory);
    } catch (error) {
      result.skippedSessions.push({
        sessionId: manifestBefore.sessionId,
        reason: `failed to reconcile session: ${getErrorMessage(error)}`,
      });
      continue;
    }

    let manifestAfter: SessionRecord | null;
    try {
      manifestAfter = await dependencies.readManifestIfExists(manifestFile);
    } catch (error) {
      result.skippedSessions.push({
        sessionId: manifestBefore.sessionId,
        reason: `failed to read reconciled manifest: ${getErrorMessage(error)}`,
      });
      continue;
    }

    if (manifestAfter === null) {
      result.skippedSessions.push({
        sessionId: manifestBefore.sessionId,
        reason: 'session manifest disappeared after reconcile',
      });
      continue;
    }

    const sessionId = manifestAfter.sessionId;
    if (!isCollectableSessionStatus(manifestAfter.status)) {
      result.skippedSessions.push({
        sessionId,
        reason: 'session host is still alive',
      });
      continue;
    }

    const staleSession = wasReconciledFromStaleHost(
      manifestBefore,
      manifestAfter,
    );
    if (options.staleOnly && !staleSession) {
      result.skippedSessions.push({
        sessionId,
        reason: 'session is not stale',
      });
      continue;
    }

    if (shouldSkipForAge(manifestAfter, options.olderThanMs, now)) {
      result.skippedSessions.push({
        sessionId,
        reason: 'session is newer than the requested age threshold',
      });
      continue;
    }

    const sessionBytes = await measurePathBytes(
      sessionDirectory,
      dependencies,
    ).catch(() => 0);

    if (!options.dryRun) {
      let finalManifest: SessionRecord | null;
      try {
        finalManifest = await dependencies.readManifestIfExists(manifestFile);
      } catch (error) {
        result.skippedSessions.push({
          sessionId,
          reason: `failed final manifest safety check: ${getErrorMessage(error)}`,
        });
        continue;
      }

      if (
        finalManifest !== null &&
        !isCollectableSessionStatus(finalManifest.status)
      ) {
        result.skippedSessions.push({
          sessionId,
          reason: 'session restarted between check and delete',
        });
        continue;
      }

      try {
        await dependencies.rm(sessionDirectory, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        result.skippedSessions.push({
          sessionId,
          reason: `failed to remove session directory: ${getErrorMessage(error)}`,
        });
        continue;
      }
    }

    result.removedSessions.push(sessionId);
    result.totalBytesFreed += sessionBytes;
  }

  return result;
}

async function homeDirectoryExists(home: string): Promise<boolean> {
  try {
    const stats = await stat(home);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function homeHasSessionDirectories(home: string): Promise<boolean> {
  try {
    const entries = await readdir(resolve(home, 'sessions'), {
      withFileTypes: true,
    });
    // Count only real Session directories; stray files (e.g. macOS .DS_Store or
    // a lock file) must not keep an otherwise-empty Home registered.
    return entries.some((entry) => entry.isDirectory());
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false; // the sessions tree is gone → no Sessions left
    }
    // Unreadable for another reason (e.g. EACCES): the Home directory is still
    // the source of truth, so stay conservative and do NOT treat it as empty
    // (which would wrongly deregister a Home over a transient permission error).
    return true;
  }
}

export interface GcCommandDependencies {
  sweepHome: (
    home: string,
    options: GcExecutionOptions,
  ) => Promise<GcSessionSweep>;
  readRegistry: () => Promise<Array<{ path: string }>>;
  forgetHome: (home: string) => Promise<unknown>;
  homeExists: (home: string) => Promise<boolean>;
  homeHasSessions: (home: string) => Promise<boolean>;
}

const defaultCommandDependencies: GcCommandDependencies = {
  sweepHome: (home, options) => gcSessions(home, options),
  readRegistry: () => readHomeRegistry(),
  forgetHome: (home) => forgetHomeDefault(home),
  homeExists: homeDirectoryExists,
  homeHasSessions: homeHasSessionDirectories,
};

export async function runGcCommand(
  options: CommandOptions,
  dependencies: GcCommandDependencies = defaultCommandDependencies,
): Promise<void> {
  const olderThanMs =
    options.olderThan === undefined
      ? null
      : parseDurationToMs(options.olderThan);
  const executionOptions: GcExecutionOptions = {
    dryRun: options.dryRun,
    staleOnly: options.staleOnly,
    olderThanMs,
  };

  // An explicitly selected Home (--home / AGENT_TTY_HOME) scopes gc to that one
  // Home and never touches the registry. Plain `gc` sweeps every registered
  // Home and prunes dead/emptied ones. The resolved default Home is always
  // swept too, so `gc` still collects it even before it has been registered.
  const sweepRegistry = !options.context.explicitHome;
  const targets: string[] = [];
  const seen = new Set<string>();
  const addTarget = (home: string): void => {
    if (!seen.has(home)) {
      seen.add(home);
      targets.push(home);
    }
  };
  addTarget(options.context.home);

  const registeredPaths = new Set<string>();
  if (sweepRegistry) {
    const entries = await dependencies.readRegistry();
    for (const entry of entries) {
      registeredPaths.add(entry.path);
      addTarget(entry.path);
    }
  }

  const homes: GcHomeOutcome[] = [];
  const deregisteredHomes: string[] = [];
  for (const home of targets) {
    const existed = await dependencies.homeExists(home);
    const sweep = await dependencies.sweepHome(home, executionOptions);

    let deregistered = false;
    // Only ever deregister a Home that is actually registered. Emptied or gone
    // Homes drop out so the picker/`home list` stay tidy; never delete the Home
    // directory itself. Under --dry-run nothing is removed, so only an
    // already-gone Home reads as a would-deregister.
    if (sweepRegistry && registeredPaths.has(home)) {
      const noSessionsLeft =
        !existed || !(await dependencies.homeHasSessions(home));
      if (noSessionsLeft) {
        deregistered = true;
        deregisteredHomes.push(home);
        if (!options.dryRun) {
          await dependencies.forgetHome(home);
        }
      }
    }

    homes.push({
      home,
      existed,
      removedSessions: sweep.removedSessions,
      skippedSessions: sweep.skippedSessions,
      totalBytesFreed: sweep.totalBytesFreed,
      deregistered,
    });
  }

  const result: GcResult = {
    dryRun: options.dryRun,
    homes,
    removedSessionCount: homes.reduce(
      (total, home) => total + home.removedSessions.length,
      0,
    ),
    totalBytesFreed: homes.reduce(
      (total, home) => total + home.totalBytesFreed,
      0,
    ),
    deregisteredHomes,
  };

  emitSuccess({
    command: 'gc',
    json: options.json,
    result,
    lines: buildGcLines(result),
  });
}
