import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { ulid } from 'ulid';

import { CliError } from '../cli/errors.js';
import { DESTROY_RERUN_ENV_KEY } from '../config/defaults.js';
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
  writeDestroyMarker,
  writeManifest,
} from '../storage/manifests.js';
import {
  destroyMarkerPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../storage/sessionPaths.js';
import { makeAbortError, throwIfAborted } from '../util/abort.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';
import {
  isProgramGroupAlive,
  parseProcStat,
  readProgramGroup,
  readProvenProgramGroup,
  stopProgramGroup,
  type ProgramGroup,
} from './programGroup.js';
import { judgeHost, readHostRecord, type HostRecord } from './hostRecord.js';
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

export function isProcessAlive(pid: number | null): boolean {
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

const HOST_SUBCOMMAND = '_host';

interface SessionHost {
  readonly pid: number;
  readonly sessionId: string;
  readonly record: HostRecord | null;
}

async function readSessionHost(
  sessionDirectory: string,
  manifest: SessionRecord,
): Promise<SessionHost | null> {
  return manifest.hostPid === null
    ? null
    : {
        pid: manifest.hostPid,
        sessionId: manifest.sessionId,
        record: await readHostRecord(sessionDirectory),
      };
}

function psShowsSessionHost(host: SessionHost): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  let args: string[];
  try {
    args = execFileSync(
      '/bin/ps',
      ['-ww', '-o', 'command=', '-p', String(host.pid)],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/);
  } catch {
    return false;
  }
  return args.some(
    (arg, index) =>
      arg === HOST_SUBCOMMAND && args[index + 1] === host.sessionId,
  );
}

function isHostAlive(host: SessionHost | null): boolean {
  return host !== null && judgeHost(host.pid, host.record) !== 'dead';
}

function hostMatches(host: SessionHost): boolean {
  return process.platform === 'linux'
    ? judgeHost(host.pid, host.record) === 'alive'
    : psShowsSessionHost(host);
}

function killHostBestEffort(host: SessionHost | null): void {
  // Node has no pidfd API, so the kill races a pid that the host gives up
  // after hostMatches read it.
  if (host !== null && hostMatches(host)) {
    killProcessBestEffort(host.pid);
  }
}

// A chroot or a container without a mounted /proc has no /proc/self/stat.
// In a PID namespace whose session leader runs outside it (`unshare -p -f`,
// bwrap without --new-session), the kernel shows session id 0. Either way
// the id is unknown, and the CLI then counts as inside the session.
function ownLinuxSessionId(): number | null {
  let stat: string;
  try {
    stat = readFileSync('/proc/self/stat', 'utf8');
  } catch {
    return null;
  }
  const { sid } = parseProcStat(stat);
  invariant(sid >= 0, 'own session id must not be negative');
  return sid === 0 ? null : sid;
}

// macOS and the BSDs ship ps at /bin/ps, so a restricted PATH cannot hide
// it. Without it the CLI takes the destroy path it had before this check.
function ownProcessGroupId(): number | null {
  let output: string;
  try {
    output = execFileSync(
      '/bin/ps',
      ['-o', 'pgid=', '-p', String(process.pid)],
      {
        encoding: 'utf8',
      },
    );
  } catch {
    return null;
  }
  const pgid = Number(output.trim());
  invariant(
    Number.isInteger(pgid) && pgid > 0,
    'own process group id must be a positive integer',
  );
  return pgid;
}

function controllingTerminal(pid: number): string | null {
  let output: string;
  try {
    output = execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], {
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
  const tty = output.trim();
  // A terminal name such as ttys001 or pts/3 starts with a letter and ends
  // with a digit. For a process without a terminal ps prints ?? (macOS,
  // OpenBSD), ? (procps, NetBSD) or - (FreeBSD), and any other value that
  // names no terminal reads as none too, so two of them never match.
  return /^[a-z][\w/]*\d$/i.test(tty) ? tty : null;
}

// A terminal is the controlling terminal of at most one session and of
// every process in it. The program leads its session with the PTY as that
// terminal, so a process with the program's terminal runs in its session.
function sharesControllingTerminal(pid: number): boolean {
  const own = controllingTerminal(process.pid);
  return own !== null && own === controllingTerminal(pid);
}

// The program and the processes it starts inherit AGENT_TTY_SESSION_ID at
// spawn, before any manifest names the program's pid. `create --env` can
// override that variable, so the ids are compared too. The program leads its
// own session, so a process inside that session has the program's pid as its
// session id. Linux compares that id, which also covers a job that the
// program's shell put in a group of its own. POSIX ps has no session id
// field, so other systems compare the process group and the controlling
// terminal. Windows has no sessions or groups.
export async function cliRunsInsideProgramSession(
  sessionId: string,
): Promise<boolean> {
  if (process.platform === 'win32') {
    return false;
  }

  if (process.env.AGENT_TTY_SESSION_ID === sessionId) {
    return true;
  }

  const { manifestFile } = getSessionPaths(sessionId);
  const manifest = await readManifestIfExists(manifestFile);
  if (manifest === null || manifest.childPid === null) {
    return false;
  }

  if (process.platform === 'linux') {
    // A CLI that cannot read its session id runs again in a new session,
    // where the copy skips this check: a needless copy costs one re-run.
    const sid = ownLinuxSessionId();
    return sid === null || manifest.childPid === sid;
  }
  return (
    manifest.childPid === ownProcessGroupId() ||
    sharesControllingTerminal(manifest.childPid)
  );
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

export async function removeSocketDirectoryIfEmpty(
  socketFile: string,
): Promise<void> {
  try {
    await rmdir(dirname(socketFile));
  } catch (error) {
    if (
      hasErrorCode(error, 'ENOENT') ||
      hasErrorCode(error, 'ENOTEMPTY') ||
      hasErrorCode(error, 'EEXIST')
    ) {
      return;
    }

    throw error;
  }
}

// For a process whose work is already done: an unusual rmdir error, such as
// EBUSY or EPERM, is logged and must not fail it.
export async function removeSocketDirectoryBestEffort(
  socketFile: string,
): Promise<void> {
  try {
    await removeSocketDirectoryIfEmpty(socketFile);
  } catch (error) {
    console.debug('could not remove the socket directory:', error);
  }
}

const SOCKET_LISTEN_ATTEMPTS = 5;

// libuv reports a bind in a missing directory as EACCES.
function isVanishedSocketDirectory(
  error: unknown,
  socketDirectory: string,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code, path, syscall } = error as NodeJS.ErrnoException;
  return (
    (syscall === 'listen' && (code === 'EACCES' || code === 'ENOENT')) ||
    (syscall === 'chmod' && code === 'ENOENT' && path === socketDirectory)
  );
}

export async function listenInSocketDirectory(
  socketFile: string,
  listen: () => Promise<void>,
): Promise<void> {
  const socketDirectory = dirname(socketFile);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await mkdir(socketDirectory, { recursive: true });
      await chmod(socketDirectory, 0o700);
      await listen();
      return;
    } catch (error) {
      if (
        attempt === SOCKET_LISTEN_ATTEMPTS ||
        !isVanishedSocketDirectory(error, socketDirectory)
      ) {
        throw error;
      }
    }
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

export async function waitForProcessesToExit(
  host: SessionHost | null,
  group: ProgramGroup | null,
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
    if (!isHostAlive(host) && !isProgramGroupAlive(group)) {
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
  launch: (sessionId: string) => number,
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

  // Before the cwd check, because the cwd can be the Home this call creates.
  const home = await ensureHome(config.home);

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

  const sessionDirectory = sessionDir(home, sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  // Owner-only: this directory holds the event log and all artifacts, so 0o700
  // here protects every per-session file regardless of each file's own mode.
  await chmod(sessionDirectory, 0o700);

  const hostPid = launch(sessionId);

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
    hostPid,
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

export interface LaunchedHost {
  readonly pid: number;
  // Sends the host SIGTERM, which makes it stop its program and end the
  // session. It sends nothing once the host has exited, so a reused pid
  // never gets the signal. On Windows, SIGTERM ends the host at once, without
  // its shutdown.
  stop(): void;
}

export function launchHost(config: LaunchHostConfig): LaunchedHost {
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
    [
      ...process.execArgv,
      entrypoint,
      HOST_SUBCOMMAND,
      config.sessionId,
      // The host waits for the first manifest while this process lives.
      String(process.pid),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...config.env,
        [DESTROY_RERUN_ENV_KEY]: undefined,
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

  return {
    pid: child.pid,
    stop: () => {
      child.kill('SIGTERM');
    },
  };
}

async function recordDestroyed(
  manifestFile: string,
  socketFile: string,
  manifest: SessionRecord,
  group: ProgramGroup | null,
): Promise<void> {
  invariant(
    isTerminalSessionStatus(manifest.status) ||
      (!isHostAlive(await readSessionHost(dirname(manifestFile), manifest)) &&
        !isProgramGroupAlive(group)),
    'recordDestroyed needs a terminal manifest or dead session processes',
  );
  if (!isDestroyedSessionStatus(manifest.status)) {
    await writeDestroyMarker(
      destroyMarkerPath(dirname(manifestFile)),
      manifest.sessionId,
    );
    await writeManifest(manifestFile, {
      ...manifest,
      status: 'destroyed',
      updatedAt: new Date().toISOString(),
    });
  }
  await unlinkIfPresent(socketFile);
  await removeSocketDirectoryIfEmpty(socketFile);
}

async function stopSessionProcesses(
  sessionId: string,
  host: SessionHost | null,
  group: ProgramGroup | null,
  sessionDirectory: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  stopProgramGroup(group);
  killHostBestEffort(host);

  const stopped = await waitForProcessesToExit(
    host,
    group,
    DESTROY_MAX_ATTEMPTS,
    DESTROY_POLL_INTERVAL_MS,
    pollOptions(signal),
  );
  if (!stopped) {
    // Without /proc nothing proves the program's group or the host. An empty
    // /proc mount point has no /proc/self. Only a host can end the session
    // for a plain destroy.
    const hint =
      process.platform === 'linux' && !existsSync('/proc/self')
        ? ` This process cannot read /proc, so it cannot prove which processes are the session's. ${
            host === null
              ? 'Run destroy where /proc is mounted.'
              : 'End the session with a plain destroy, or run destroy --force where /proc is mounted.'
          }`
        : '';
    throw makeCliError(ERROR_CODES.HOST_TIMEOUT, {
      message: `Timed out forcing session "${sessionId}" to exit.${hint}`,
      details: { sessionId, sessionDirectory },
    });
  }
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

  const stopLeftoversThenRecordDestroyed = async (
    terminal: SessionRecord,
  ): Promise<void> => {
    await stopSessionProcesses(
      sessionId,
      null,
      await readProvenProgramGroup(sessionDirectory),
      sessionDirectory,
      signal,
    );
    await recordDestroyed(manifestFile, socketFile, terminal, null);
  };

  if (isTerminalSessionStatus(manifest.status)) {
    await stopLeftoversThenRecordDestroyed(manifest);
    return;
  }

  if (force === true) {
    await stopSessionProcesses(
      sessionId,
      await readSessionHost(sessionDirectory, manifest),
      await readProgramGroup(sessionDirectory, manifest.childPid),
      sessionDirectory,
      signal,
    );
    // The host is dead now, so this read is final. It can name a child that
    // the first read did not.
    const current = await readSessionManifestOrThrow(sessionId, manifestFile);
    const group = await readProgramGroup(sessionDirectory, current.childPid);
    await stopSessionProcesses(
      sessionId,
      await readSessionHost(sessionDirectory, current),
      group,
      sessionDirectory,
      signal,
    );
    await recordDestroyed(manifestFile, socketFile, current, group);
    return;
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
      await stopLeftoversThenRecordDestroyed(reconciledManifest);
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
    await stopLeftoversThenRecordDestroyed(terminalManifest);
    return;
  }

  await reconcileSession(sessionDirectory);
  const reconciledManifest = await readSessionManifestOrThrow(
    sessionId,
    manifestFile,
  );
  if (isTerminalSessionStatus(reconciledManifest.status)) {
    await stopLeftoversThenRecordDestroyed(reconciledManifest);
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

  const hostAlive = isHostAlive(
    await readSessionHost(sessionDirectory, manifest),
  );
  if (manifest.hostPid !== null && hostAlive) {
    return;
  }

  const current = await readManifestIfExists(manifestFile);
  if (current === null || isTerminalSessionStatus(current.status)) {
    return;
  }
  // The program can outlive its host. This copy names it even when the first
  // read came before the host's start-up write.
  const group = await readProgramGroup(sessionDirectory, current.childPid);
  stopProgramGroup(group);
  // A kill can leave processes of another user, such as the root child of
  // `sudo cmd &`. Keep childPid so that a later reconcile retries.
  if (!(await waitForProcessesToExit(null, group))) {
    return;
  }
  // A destroy or another reconcile can write a terminal status during the
  // wait.
  const latest = await readManifestIfExists(manifestFile);
  if (latest === null || isTerminalSessionStatus(latest.status)) {
    return;
  }

  let reconciledStatus: SessionRecord['status'];
  let failureReason: string | undefined;
  let failureOrigin: FailureOrigin | undefined;

  switch (latest.status) {
    case 'running':
      reconciledStatus = 'failed';
      failureReason =
        latest.hostPid !== null
          ? `host process died unexpectedly (pid: ${String(latest.hostPid)})`
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
      failureReason = `unexpected pre-reconcile status: ${latest.status}`;
      failureOrigin = 'unknown';
      break;
  }

  const reconciledManifest: SessionRecord = {
    ...latest,
    status: reconciledStatus,
    updatedAt: new Date().toISOString(),
    hostPid: null,
    childPid: null,
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(failureOrigin !== undefined ? { failureOrigin } : {}),
  };

  try {
    await writeManifest(manifestFile, reconciledManifest);
    if (
      reconciledStatus !== 'destroyed' &&
      existsSync(destroyMarkerPath(sessionDirectory))
    ) {
      await writeManifest(manifestFile, {
        ...latest,
        status: 'destroyed',
        updatedAt: new Date().toISOString(),
        hostPid: null,
        childPid: null,
      });
    }
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === ERROR_CODES.SESSION_NOT_FOUND
    ) {
      return;
    }
    throw error;
  }
  const socketFile = socketPath(sessionDirectory);
  await unlinkIfPresent(socketFile);
  await removeSocketDirectoryIfEmpty(socketFile);
}
