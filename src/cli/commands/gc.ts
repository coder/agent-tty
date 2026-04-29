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
import { readManifestIfExists } from '../../storage/manifests.js';
import { manifestPath, sessionDir } from '../../storage/sessionPaths.js';
import { invariant } from '../../util/assert.js';

interface NodeError extends Error {
  code?: string;
}

export interface GcResult {
  removedSessions: string[];
  skippedSessions: Array<{
    sessionId: string;
    reason: string;
  }>;
  dryRun: boolean;
  totalBytesFreed: number;
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

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeError).code === code;
}

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
    `${actionLabel} ${String(result.removedSessions.length)} session(s).`,
  );
  lines.push(`${bytesLabel}: ${String(result.totalBytesFreed)}`);

  if (result.removedSessions.length > 0) {
    lines.push('Sessions:');
    for (const sessionId of result.removedSessions) {
      lines.push(`  - ${sessionId}`);
    }
  }

  if (result.skippedSessions.length > 0) {
    lines.push('Skipped:');
    for (const skippedSession of result.skippedSessions) {
      lines.push(`  - ${skippedSession.sessionId}: ${skippedSession.reason}`);
    }
  }

  if (
    result.removedSessions.length === 0 &&
    result.skippedSessions.length === 0
  ) {
    lines.push('No sessions found.');
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
): Promise<GcResult> {
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

  const result: GcResult = {
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

export async function runGcCommand(options: CommandOptions): Promise<void> {
  const olderThanMs =
    options.olderThan === undefined
      ? null
      : parseDurationToMs(options.olderThan);
  const home = options.context.home;
  const result = await gcSessions(home, {
    dryRun: options.dryRun,
    staleOnly: options.staleOnly,
    olderThanMs,
  });

  emitSuccess({
    command: 'gc',
    json: options.json,
    result,
    lines: buildGcLines(result),
  });
}
