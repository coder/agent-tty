import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { ulid } from 'ulid';

import { CliError } from '../cli/errors.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import {
  isActiveSessionStatus,
  isDestroyedSessionStatus,
  isTerminalSessionStatus,
} from '../protocol/sessionStatusPolicy.js';
import type { FailureOrigin, SessionRecord } from '../protocol/schemas.js';
import { ensureHome, resolveHome } from '../storage/home.js';
import {
  readManifest,
  readManifestIfExists,
  writeManifest,
} from '../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../storage/sessionPaths.js';
import { makeAbortError, throwIfAborted } from '../util/abort.js';
import { invariant } from '../util/assert.js';
import { sendRpc } from './rpcClient.js';

const DESTROY_POLL_INTERVAL_MS = 100;
const DESTROY_MAX_ATTEMPTS = 50;

interface PollOptions {
  readonly signal?: AbortSignal;
}

function pollOptions(signal?: AbortSignal): PollOptions {
  return signal === undefined ? {} : { signal };
}

function delayOptions(
  signal?: AbortSignal,
): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal };
}

async function pollDelay(
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await delay(intervalMs, undefined, delayOptions(signal));
  } catch (error) {
    if (signal?.aborted === true) {
      throw makeAbortError(signal);
    }
    throw error;
  }
}

interface NodeError extends Error {
  code?: string;
}

export interface AllocateConfig {
  home: string;
  command: string[];
  shellPath: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  term: string;
  idleTimeoutMs?: number;
  name?: string;
}

export interface LaunchHostConfig {
  sessionId: string;
  home: string;
  env: Record<string, string>;
  term: string;
}

export interface AllocateResult {
  sessionId: string;
  sessionDirectory: string;
}

export interface SessionSummary {
  sessionId: string;
  status: string;
  command: string[];
  createdAt: string;
  name?: string;
  pid: number | null;
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isNodeError(error) && error.code === code;
}

function makeInvalidDimensionError(
  label: 'cols' | 'rows',
  value: unknown,
): CliError {
  return makeCliError(ERROR_CODES.INVALID_DIMENSIONS, {
    message: `${label} must be a positive integer, got: ${String(value)}`,
    details: {
      [label]: value,
    },
  });
}

function makeInvalidCwdError(cwd: unknown, cause?: unknown): CliError {
  return makeCliError(ERROR_CODES.STORAGE_READ_ERROR, {
    message:
      typeof cwd === 'string' && cwd.length > 0
        ? `Working directory does not exist or is not accessible: ${cwd}`
        : 'Working directory must be a non-empty string.',
    details: { cwd },
    cause,
  });
}

function makeInvalidShellError(shellPath: unknown, cause?: unknown): CliError {
  return makeCliError(ERROR_CODES.INVALID_INPUT, {
    message:
      typeof shellPath === 'string' && shellPath.length > 0
        ? `Shell path does not exist or is not accessible: ${shellPath}`
        : 'Shell path must be a non-empty string.',
    details: { shellPath },
    cause,
  });
}

function assertPositiveInteger(value: number, label: string): void {
  invariant(
    Number.isInteger(value) && value > 0,
    `${label} must be a positive integer`,
  );
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  invariant(typeof value === 'string', `${label} must be a string`);
  invariant(value.length > 0, `${label} must not be empty`);
}

function assertStringRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, string> {
  invariant(
    value !== null && typeof value === 'object',
    `${label} must be an object`,
  );

  for (const [entryKey, entryValue] of Object.entries(value)) {
    invariant(entryKey.length > 0, `${label} keys must not be empty`);
    invariant(
      typeof entryValue === 'string',
      `${label} values must be strings`,
    );
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null) {
    return false;
  }

  assertPositiveInteger(pid, 'pid');

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return false;
    }

    throw error;
  }
}

function killProcessBestEffort(pid: number | null): void {
  if (pid === null) {
    return;
  }

  assertPositiveInteger(pid, 'pid');

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return;
    }

    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }

    throw error;
  }
}

function getSessionPaths(sessionId: string): {
  sessionDirectory: string;
  manifestFile: string;
  socketFile: string;
} {
  assertNonEmptyString(sessionId, 'sessionId');

  const home = resolveHome();
  const sessionDirectory = sessionDir(home, sessionId);

  return {
    sessionDirectory,
    manifestFile: manifestPath(sessionDirectory),
    socketFile: socketPath(sessionDirectory),
  };
}

async function readSessionManifestOrThrow(
  sessionId: string,
  manifestFile: string,
): Promise<SessionRecord> {
  const manifest = await readManifestIfExists(manifestFile);

  if (manifest !== null) {
    return manifest;
  }

  throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
    message: `Session "${sessionId}" was not found.`,
    details: {
      sessionId,
      manifestPath: manifestFile,
    },
  });
}

async function waitForTerminalManifest(
  manifestFile: string,
  maxAttempts: number = DESTROY_MAX_ATTEMPTS,
  intervalMs: number = DESTROY_POLL_INTERVAL_MS,
  options: PollOptions = {},
): Promise<SessionRecord | null> {
  invariant(
    Number.isInteger(maxAttempts) && maxAttempts > 0,
    'maxAttempts must be a positive integer',
  );
  invariant(
    Number.isInteger(intervalMs) && intervalMs >= 0,
    'intervalMs must be a non-negative integer',
  );

  const { signal } = options;
  throwIfAborted(signal);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const manifest = await readManifest(manifestFile);

    if (isTerminalSessionStatus(manifest.status)) {
      return manifest;
    }

    if (attempt + 1 < maxAttempts) {
      await pollDelay(intervalMs, signal);
    }
  }

  return null;
}

async function waitForProcessAndSocketShutdown(
  hostPid: number | null,
  childPid: number | null,
  socketFile: string,
  maxAttempts: number = DESTROY_MAX_ATTEMPTS,
  intervalMs: number = DESTROY_POLL_INTERVAL_MS,
  options: PollOptions = {},
): Promise<boolean> {
  invariant(
    Number.isInteger(maxAttempts) && maxAttempts > 0,
    'maxAttempts must be a positive integer',
  );
  invariant(
    Number.isInteger(intervalMs) && intervalMs >= 0,
    'intervalMs must be a non-negative integer',
  );

  const { signal } = options;
  throwIfAborted(signal);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const hostAlive = isProcessAlive(hostPid);
    const childAlive = isProcessAlive(childPid);
    const socketPresent = await pathExists(socketFile);

    if (!hostAlive && !childAlive && !socketPresent) {
      return true;
    }

    if (attempt + 1 < maxAttempts) {
      await pollDelay(intervalMs, signal);
    }
  }

  return false;
}

export async function allocateSession(
  config: AllocateConfig,
): Promise<AllocateResult> {
  const rawConfig: unknown = config;
  invariant(
    rawConfig !== null && typeof rawConfig === 'object',
    'config must be an object',
  );
  assertNonEmptyString(config.home, 'home');
  invariant(Array.isArray(config.command), 'command must be an array');
  assertNonEmptyString(config.shellPath, 'shellPath');
  assertStringRecord(config.env, 'env');
  assertNonEmptyString(config.term, 'term');
  if (config.name !== undefined) {
    assertNonEmptyString(config.name.trim(), 'name');
  }
  if (
    typeof config.cols !== 'number' ||
    !Number.isInteger(config.cols) ||
    config.cols <= 0
  ) {
    throw makeInvalidDimensionError('cols', config.cols);
  }
  if (
    typeof config.rows !== 'number' ||
    !Number.isInteger(config.rows) ||
    config.rows <= 0
  ) {
    throw makeInvalidDimensionError('rows', config.rows);
  }
  if (config.idleTimeoutMs !== undefined) {
    invariant(
      Number.isInteger(config.idleTimeoutMs) && config.idleTimeoutMs >= 0,
      'idleTimeoutMs must be a non-negative integer',
    );
  }
  if (typeof config.cwd !== 'string' || config.cwd.length === 0) {
    throw makeInvalidCwdError(config.cwd);
  }

  const sessionId = ulid();
  assertNonEmptyString(sessionId, 'sessionId');

  const home = await ensureHome(config.home);
  const sessionDirectory = sessionDir(home, sessionId);
  await mkdir(sessionDirectory, { recursive: true });

  const resolvedCwd = resolve(config.cwd);
  try {
    const cwdStats = await stat(resolvedCwd);
    invariant(
      cwdStats.isDirectory(),
      'cwd must resolve to an existing directory',
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw makeCliError(ERROR_CODES.STORAGE_READ_ERROR, {
      message: `Working directory does not exist or is not accessible: ${resolvedCwd}`,
      details: { cwd: resolvedCwd },
      cause: error,
    });
  }

  const resolvedShellPath = resolve(config.shellPath);
  try {
    const shellStats = await stat(resolvedShellPath);
    invariant(
      shellStats.isFile(),
      'shell path must resolve to an existing file',
    );
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw makeInvalidShellError(resolvedShellPath, error);
  }

  const effectiveCommand =
    config.command.length > 0 ? [...config.command] : [resolvedShellPath];
  invariant(effectiveCommand.length > 0, 'effective command must not be empty');
  for (const commandPart of effectiveCommand) {
    assertNonEmptyString(commandPart, 'command segment');
  }

  const now = new Date().toISOString();
  await writeManifest(manifestPath(sessionDirectory), {
    version: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    command: effectiveCommand,
    cwd: resolvedCwd,
    cols: config.cols,
    rows: config.rows,
    creationCols: config.cols,
    creationRows: config.rows,
    hostPid: null,
    childPid: null,
    exitCode: null,
    exitSignal: null,
    ...(config.idleTimeoutMs !== undefined && config.idleTimeoutMs > 0
      ? { idleTimeoutMs: config.idleTimeoutMs }
      : {}),
    ...(config.name !== undefined ? { name: config.name } : {}),
    ...(Object.keys(config.env).length > 0 ? { env: { ...config.env } } : {}),
    shell: resolvedShellPath,
    term: config.term,
  });

  return { sessionId, sessionDirectory };
}

export function launchHost(config: LaunchHostConfig): number {
  assertNonEmptyString(config.sessionId, 'sessionId');
  assertNonEmptyString(config.home, 'home');
  assertStringRecord(config.env, 'env');
  assertNonEmptyString(config.term, 'term');
  invariant(process.execPath.length > 0, 'process.execPath must not be empty');

  const entrypoint = process.argv[1];
  invariant(
    typeof entrypoint === 'string' && entrypoint.length > 0,
    'CLI entrypoint path must be defined',
  );

  const child = spawn(
    process.execPath,
    [...process.execArgv, entrypoint, '_host', config.sessionId],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...config.env,
        AGENT_TTY_HOME: config.home,
        TERM: config.term,
      },
    },
  );
  child.unref();

  invariant(
    child.pid !== undefined && child.pid > 0,
    'Detached host process must expose a positive PID',
  );

  return child.pid;
}

export interface DestroySessionOptions {
  readonly signal?: AbortSignal;
}

export async function destroySession(
  sessionId: string,
  force?: boolean,
  options: DestroySessionOptions = {},
): Promise<void> {
  const { signal } = options;
  throwIfAborted(signal);
  const { sessionDirectory, manifestFile, socketFile } =
    getSessionPaths(sessionId);
  const manifest = await readSessionManifestOrThrow(sessionId, manifestFile);

  if (isDestroyedSessionStatus(manifest.status)) {
    throw makeCliError(ERROR_CODES.SESSION_ALREADY_DESTROYED, {
      message: `Session "${sessionId}" is already destroyed.`,
      details: { sessionId },
    });
  }

  if (isTerminalSessionStatus(manifest.status)) {
    const destroyedManifest: SessionRecord = {
      ...manifest,
      status: 'destroyed',
      updatedAt: new Date().toISOString(),
    };

    await writeManifest(manifestFile, destroyedManifest);
    await unlinkIfPresent(socketFile);
    return;
  }

  if (force === true) {
    killProcessBestEffort(manifest.childPid);
    killProcessBestEffort(manifest.hostPid);

    await waitForProcessAndSocketShutdown(
      manifest.hostPid,
      manifest.childPid,
      socketFile,
      DESTROY_MAX_ATTEMPTS,
      DESTROY_POLL_INTERVAL_MS,
      pollOptions(signal),
    );
    await reconcileSession(sessionDirectory);

    const reconciledManifest = await readSessionManifestOrThrow(
      sessionId,
      manifestFile,
    );
    if (isTerminalSessionStatus(reconciledManifest.status)) {
      return;
    }

    throw makeCliError(ERROR_CODES.HOST_TIMEOUT, {
      message: `Timed out forcing session "${sessionId}" to exit.`,
      details: {
        sessionId,
        sessionDirectory,
      },
    });
  }

  try {
    throwIfAborted(signal);
    await sendRpc(socketFile, 'destroy', undefined, undefined, signal);
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      error.code !== ERROR_CODES.HOST_UNREACHABLE
    ) {
      throw error;
    }

    await reconcileSession(sessionDirectory);
    const reconciledManifest = await readSessionManifestOrThrow(
      sessionId,
      manifestFile,
    );
    if (isTerminalSessionStatus(reconciledManifest.status)) {
      return;
    }

    throw error;
  }

  const terminalManifest = await waitForTerminalManifest(
    manifestFile,
    DESTROY_MAX_ATTEMPTS,
    DESTROY_POLL_INTERVAL_MS,
    pollOptions(signal),
  );
  if (terminalManifest !== null) {
    return;
  }

  await reconcileSession(sessionDirectory);
  const reconciledManifest = await readSessionManifestOrThrow(
    sessionId,
    manifestFile,
  );
  if (isTerminalSessionStatus(reconciledManifest.status)) {
    return;
  }

  throw makeCliError(ERROR_CODES.HOST_TIMEOUT, {
    message: `Timed out waiting for session "${sessionId}" to exit after destroy request.`,
    details: {
      sessionId,
      sessionDirectory,
    },
  });
}

export async function listSessions(
  home: string,
  all?: boolean,
): Promise<SessionSummary[]> {
  assertNonEmptyString(home, 'home');

  const sessionsRoot = resolve(home, 'sessions');
  let sessionEntries: string[];
  try {
    sessionEntries = await readdir(sessionsRoot);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }

    throw error;
  }

  const summaries: SessionSummary[] = [];

  for (const entry of sessionEntries) {
    const sessionDirectory = sessionDir(home, entry);
    const manifestFile = manifestPath(sessionDirectory);

    let manifest: SessionRecord | null;
    try {
      manifest = await readManifestIfExists(manifestFile);
    } catch {
      continue;
    }

    if (manifest === null) {
      continue;
    }

    if (isActiveSessionStatus(manifest.status)) {
      try {
        await reconcileSession(sessionDirectory);
        manifest = await readManifestIfExists(manifestFile);
      } catch {
        continue;
      }

      if (manifest === null) {
        continue;
      }
    }

    if (all !== true && isTerminalSessionStatus(manifest.status)) {
      continue;
    }

    summaries.push({
      sessionId: manifest.sessionId,
      status: manifest.status,
      command: [...manifest.command],
      createdAt: manifest.createdAt,
      ...(manifest.name !== undefined ? { name: manifest.name } : {}),
      pid: manifest.childPid ?? null,
    });
  }

  return summaries;
}

export async function reconcileSession(
  sessionDirectory: string,
): Promise<void> {
  const manifestFile = manifestPath(sessionDirectory);
  const manifest = await readManifestIfExists(manifestFile);

  if (manifest === null || isTerminalSessionStatus(manifest.status)) {
    return;
  }

  const hostAlive = isProcessAlive(manifest.hostPid);
  if (manifest.hostPid !== null && hostAlive) {
    return;
  }

  if (manifest.childPid !== null && isProcessAlive(manifest.childPid)) {
    killProcessBestEffort(manifest.childPid);
  }

  let reconciledStatus: SessionRecord['status'];
  let failureReason: string | undefined;
  let failureOrigin: FailureOrigin | undefined;

  switch (manifest.status) {
    case 'running':
      reconciledStatus = 'failed';
      failureReason =
        manifest.hostPid !== null
          ? `host process died unexpectedly (pid: ${String(manifest.hostPid)})`
          : 'host process died unexpectedly';
      failureOrigin = 'host-death';
      break;
    case 'exiting':
      reconciledStatus = 'exited';
      break;
    case 'destroying':
      reconciledStatus = 'destroyed';
      break;
    default:
      reconciledStatus = 'failed';
      failureReason = `unexpected pre-reconcile status: ${manifest.status}`;
      failureOrigin = 'unknown';
      break;
  }

  const reconciledManifest: SessionRecord = {
    ...manifest,
    status: reconciledStatus,
    updatedAt: new Date().toISOString(),
    hostPid: null,
    childPid: null,
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(failureOrigin !== undefined ? { failureOrigin } : {}),
  };

  await writeManifest(manifestFile, reconciledManifest);
  await unlinkIfPresent(socketPath(sessionDirectory));
}
