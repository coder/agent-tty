import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { CliError } from '../errors.js';
import type { CommandContext } from '../context.js';

import { emitSuccess, writeHumanErrorLines } from '../output.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../config/defaults.js';
import {
  allocateSession,
  isProcessAlive,
  launchHost,
  type LaunchedHost,
} from '../../host/lifecycle.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ensureSocketRoot } from '../../host/socketRoot.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import type { SessionRecord } from '../../protocol/schemas.js';
import { upsertHome } from '../../storage/homeRegistry.js';
import {
  readManifestIfExists,
  writeCreateFailedMarker,
} from '../../storage/manifests.js';
import {
  createFailedMarkerPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';
import { invariant } from '../../util/assert.js';

const READINESS_POLL_INTERVAL_MS = 100;
const READINESS_MAX_ATTEMPTS = 50;
const READINESS_RPC_TIMEOUT_MS = 100;
const MARKER_RETRY_INTERVAL_MS = 100;
const MARKER_RETRY_MAX_ATTEMPTS = 50;

type SessionEnvironment = Record<string, string>;

export interface CreateResult {
  sessionId: string;
  createdAt: string;
  cols: number;
  rows: number;
  shell: string;
  env?: Record<string, string>;
  idleTimeoutMs?: number;
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  command: string[];
  shellPath: string;
  cwd: string;
  cols: number;
  rows: number;
  envEntries: string[];
  term: string;
  idleTimeoutMs?: number;
  name?: string;
}

function normalizeCreateEnvironment(envEntries: string[]): SessionEnvironment {
  const environment: SessionEnvironment = {};

  for (const entry of envEntries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: `--env must use KEY=VALUE format, got: ${entry}`,
        details: {
          env: entry,
        },
      });
    }

    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    environment[key] = value;
  }

  return environment;
}

function toCreateResult(manifest: SessionRecord): CreateResult {
  invariant(
    manifest.command.length > 0,
    'session manifest command must include at least one segment',
  );

  const shell = manifest.shell ?? manifest.command[0];
  invariant(shell !== undefined, 'session manifest shell must resolve');

  const result: CreateResult = {
    sessionId: manifest.sessionId,
    createdAt: manifest.createdAt,
    cols: manifest.cols,
    rows: manifest.rows,
    shell,
  };

  if (manifest.env !== undefined && Object.keys(manifest.env).length > 0) {
    result.env = manifest.env;
  }

  if (manifest.idleTimeoutMs !== undefined && manifest.idleTimeoutMs > 0) {
    result.idleTimeoutMs = manifest.idleTimeoutMs;
  }

  return result;
}

async function readCreateResult(
  sessionDirectory: string,
  sessionId: string,
): Promise<CreateResult> {
  const manifest = await readManifestIfExists(manifestPath(sessionDirectory));
  if (manifest === null) {
    throw makeCliError(ERROR_CODES.INTERNAL_ERROR, {
      message: `Session manifest missing for "${sessionId}" after creation.`,
      details: {
        sessionId,
        sessionDirectory,
      },
    });
  }

  return toCreateResult(manifest);
}

async function waitForReadyHost(
  socketFile: string,
  sessionDirectory: string,
  sessionId: string,
): Promise<CreateResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sendRpc(socketFile, 'inspect', undefined, READINESS_RPC_TIMEOUT_MS);
      return await readCreateResult(sessionDirectory, sessionId);
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        (error.code !== ERROR_CODES.HOST_UNREACHABLE &&
          error.code !== ERROR_CODES.HOST_TIMEOUT)
      ) {
        throw error;
      }
      const manifest = await readManifestIfExists(
        manifestPath(sessionDirectory),
      );
      if (manifest?.status === 'exited') {
        return toCreateResult(manifest);
      }
      if (attempt + 1 >= READINESS_MAX_ATTEMPTS) {
        throw error;
      }
      await delay(READINESS_POLL_INTERVAL_MS);
    }
  }
}

// Every error of the readiness wait names the session, so a caller can inspect
// or destroy what the failed create left.
function withSessionId(error: unknown, sessionId: string): CliError {
  if (error instanceof CliError) {
    return new CliError(error.code, error.message, {
      retryable: error.retryable,
      details: { ...error.details, sessionId },
      result: error.result,
      cause: error,
    });
  }

  return makeCliError(ERROR_CODES.INTERNAL_ERROR, {
    message:
      error instanceof Error ? error.message : 'Failed to create session.',
    details: { sessionId },
    cause: error,
  });
}

// A probe that throws, such as EPERM from a process of another user that
// took the host's pid, counts as an exited host, so the create still reports
// its own error.
function hostRuns(pid: number): boolean {
  try {
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

// A failed write is logged, so the create still reports its own error.
function writeMarkerOrLog(
  path: string,
  sessionId: string,
  logger: CommandContext['logger'],
): Promise<boolean> {
  return writeCreateFailedMarker(path, sessionId).then(
    () => true,
    (error: unknown) => {
      logger.debug('failed to write the create-failed marker', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    },
  );
}

export async function runCreateCommand(options: CommandOptions): Promise<void> {
  const environment = normalizeCreateEnvironment(options.envEntries);
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    options.context.configFile?.idleTimeoutMs ??
    DEFAULT_IDLE_TIMEOUT_MS;

  if (idleTimeoutMs < 0 || !Number.isInteger(idleTimeoutMs)) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: '--idle-timeout-ms must be a non-negative integer.',
      details: { idleTimeoutMs },
    });
  }

  // The host's stdio goes nowhere, so a socket root that its listen would
  // refuse is reported here.
  await ensureSocketRoot();

  let sessionId: string | undefined;
  let host: LaunchedHost | undefined;

  try {
    const allocatedSession = await allocateSession(
      {
        home: options.context.home,
        command: options.command,
        shellPath: options.shellPath,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        env: environment,
        term: options.term,
        ...(idleTimeoutMs > 0 ? { idleTimeoutMs } : {}),
        ...(options.name !== undefined ? { name: options.name } : {}),
      },
      (id) => {
        sessionId = id;
        host = launchHost({
          sessionId: id,
          home: options.context.home,
          env: environment,
          term: options.term,
        });
        return host.pid;
      },
    );
    sessionId = allocatedSession.sessionId;
  } catch (error) {
    if (sessionId !== undefined) {
      const home = options.context.home;
      await rm(sessionDir(home, sessionId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }

    if (error instanceof CliError) {
      throw error;
    }

    throw makeCliError(ERROR_CODES.INTERNAL_ERROR, {
      message:
        error instanceof Error ? error.message : 'Failed to create session.',
      cause: error,
    });
  }

  const home = options.context.home;
  // Advisory: remember this Home in the per-machine Home Registry so it can be
  // discovered later (`home list`, dashboard picker). A registry hiccup must
  // never fail session creation — but log it at debug so it stays diagnosable
  // instead of vanishing.
  await upsertHome(home).catch((error: unknown) => {
    options.context.logger.debug(
      'failed to register Home in the Home Registry',
      {
        home,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  });
  const sessionDirectory = sessionDir(home, sessionId);
  const socketFile = socketPath(sessionDirectory);

  let result: CreateResult;
  try {
    result = await waitForReadyHost(socketFile, sessionDirectory, sessionId);
  } catch (error) {
    // Every error here fails the create, and a host that answers later would
    // serve that failed session. The host knows its program's pid also
    // without a session token, so it stops the program and ends the session
    // itself. On Windows the SIGTERM ends the host at once, and only a
    // program that the manifest names can be stopped by a later reconcile.
    // So create first writes the create-failed marker, and the host checks
    // for it after its start-up write names the program: either the host
    // finds the marker, or the manifest read below finds the program.
    invariant(host !== undefined, 'a session that create polls has a host');
    const markerFile = createFailedMarkerPath(sessionDirectory);
    const manifestFile = manifestPath(sessionDirectory);
    const logger = options.context.logger;
    let marked = await writeMarkerOrLog(markerFile, sessionId, logger);
    let manifest = await readManifestIfExists(manifestFile).catch(() => null);
    // On Windows a host that the manifest does not name yet sees only the
    // marker. So while the marker write fails, create writes it again and
    // reads the manifest after each write, until the marker lands, the
    // manifest names the program, or the host has exited.
    for (
      let attempt = 1;
      process.platform === 'win32' &&
      !marked &&
      manifest?.childPid == null &&
      attempt <= MARKER_RETRY_MAX_ATTEMPTS &&
      hostRuns(host.pid);
      attempt += 1
    ) {
      await delay(MARKER_RETRY_INTERVAL_MS);
      marked = await writeMarkerOrLog(markerFile, sessionId, logger);
      manifest = await readManifestIfExists(manifestFile).catch(() => null);
    }
    if (process.platform !== 'win32' || manifest?.childPid != null) {
      host.stop();
    }
    // JSON names the session in details.sessionId. Text mode prints only the
    // error line, so name the session before it.
    if (!options.json) {
      writeHumanErrorLines([`Session ${sessionId} failed to start.`]);
    }
    throw withSessionId(error, sessionId);
  }

  emitSuccess({
    command: 'create',
    json: options.json,
    result,
    lines: [`Session created: ${sessionId}`],
  });
}
