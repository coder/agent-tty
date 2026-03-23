import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { CliError } from '../errors.js';
import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../config/defaults.js';
import {
  allocateSession,
  launchHost,
  reconcileSession,
} from '../../host/lifecycle.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

const READINESS_POLL_INTERVAL_MS = 100;
const READINESS_MAX_ATTEMPTS = 50;
const READINESS_RPC_TIMEOUT_MS = 100;

type SessionEnvironment = Record<string, string>;

export interface CreateResult {
  sessionId: string;
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

  let sessionId: string | undefined;

  try {
    const allocatedSession = await allocateSession({
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
    });
    sessionId = allocatedSession.sessionId;

    launchHost({
      sessionId,
      home: options.context.home,
      env: environment,
      term: options.term,
    });
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
  const sessionDirectory = sessionDir(home, sessionId);
  const socketFile = socketPath(sessionDirectory);
  let lastError: CliError | null = null;

  for (let attempt = 0; attempt < READINESS_MAX_ATTEMPTS; attempt += 1) {
    try {
      await sendRpc(socketFile, 'inspect', undefined, READINESS_RPC_TIMEOUT_MS);
      emitSuccess({
        command: 'create',
        json: options.json,
        result: { sessionId },
        lines: [`Session created: ${sessionId}`],
      });
      return;
    } catch (error) {
      if (
        error instanceof CliError &&
        (error.code === ERROR_CODES.HOST_UNREACHABLE ||
          error.code === ERROR_CODES.HOST_TIMEOUT)
      ) {
        const manifest = await readManifestIfExists(
          manifestPath(sessionDirectory),
        );
        if (manifest?.status === 'exited') {
          emitSuccess({
            command: 'create',
            json: options.json,
            result: { sessionId },
            lines: [`Session created: ${sessionId}`],
          });
          return;
        }

        lastError = error;
        if (attempt + 1 < READINESS_MAX_ATTEMPTS) {
          await delay(READINESS_POLL_INTERVAL_MS);
          continue;
        }
      }

      throw error;
    }
  }

  await reconcileSession(sessionDirectory).catch(() => undefined);

  throw makeCliError(ERROR_CODES.HOST_TIMEOUT, {
    message: `Timed out waiting for session "${sessionId}" to become ready.`,
    details: {
      sessionId,
      sessionDirectory,
      causeCode: lastError?.code,
    },
    cause: lastError,
  });
}
