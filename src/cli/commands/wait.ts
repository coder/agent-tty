import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { resolveHome } from '../../storage/home.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

export interface WaitResult {
  exitCode?: number;
  timedOut: boolean;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  waitForExit: boolean;
  idleMs: number | undefined;
  timeout: number | undefined;
}

const DEFAULT_WAIT_TIMEOUT_MS = 600_000;

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function waitLines(result: WaitResult): string[] {
  if (result.timedOut) {
    return ['Wait timed out.'];
  }

  if (result.exitCode !== undefined) {
    return [`Process exited with code ${String(result.exitCode)}.`];
  }

  return ['Wait condition met.'];
}

export async function runWaitCommand(options: CommandOptions): Promise<void> {
  const home = resolveHome();
  const sessionDirectory = sessionDir(home, options.sessionId);
  const manifestFile = manifestPath(sessionDirectory);
  const manifest = await readManifestIfExists(manifestFile);

  if (manifest === null) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_FOUND, {
      message: `Session "${options.sessionId}" was not found.`,
      details: {
        sessionId: options.sessionId,
        manifestPath: manifestFile,
      },
    });
  }

  const hasIdleMs = options.idleMs !== undefined;
  if (options.waitForExit === hasIdleMs) {
    throw makeCliError(ERROR_CODES.INVALID_DURATION, {
      message: 'Specify exactly one of --exit or --idle-ms.',
    });
  }

  if (hasIdleMs && !isPositiveInteger(options.idleMs)) {
    throw makeCliError(ERROR_CODES.INVALID_DURATION, {
      message: '--idle-ms must be a positive integer.',
      details: {
        idleMs: options.idleMs,
      },
    });
  }

  if (
    options.timeout !== undefined &&
    options.timeout !== 0 &&
    !isPositiveInteger(options.timeout)
  ) {
    throw makeCliError(ERROR_CODES.INVALID_DURATION, {
      message: '--timeout must be a non-negative integer (0 for infinite).',
      details: {
        timeout: options.timeout,
      },
    });
  }

  if (!options.waitForExit && manifest.status !== 'running') {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: `Session "${options.sessionId}" is not running.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  if (options.waitForExit && manifest.status === 'exited') {
    const result: WaitResult = {
      timedOut: false,
      ...(manifest.exitCode === null ? {} : { exitCode: manifest.exitCode }),
    };

    emitSuccess({
      command: 'wait',
      json: options.json,
      result,
      lines: waitLines(result),
    });
    return;
  }

  const effectiveTimeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
  const params = {
    exit: options.waitForExit || undefined,
    idleMs: options.idleMs ?? undefined,
    timeoutMs: effectiveTimeout === 0 ? undefined : effectiveTimeout,
  };
  const clientTimeout = effectiveTimeout === 0 ? 0 : effectiveTimeout + 5_000;
  const result = (await sendRpc(
    socketPath(sessionDirectory),
    'wait',
    params,
    clientTimeout,
  )) as WaitResult;

  emitSuccess({
    command: 'wait',
    json: options.json,
    result,
    lines: waitLines(result),
  });
}
