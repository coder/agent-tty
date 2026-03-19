import { setTimeout as delay } from 'node:timers/promises';

import { CliError } from '../errors.js';
import { emitSuccess } from '../output.js';
import {
  allocateSession,
  launchHost,
  reconcileSession,
} from '../../host/lifecycle.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { resolveHome } from '../../storage/home.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import { manifestPath, sessionDir, socketPath } from '../../storage/sessionPaths.js';

const READINESS_POLL_INTERVAL_MS = 100;
const READINESS_MAX_ATTEMPTS = 50;
const READINESS_RPC_TIMEOUT_MS = 100;

export interface CreateResult {
  sessionId: string;
}

interface CommandOptions {
  json: boolean;
  command: string[];
  shellCommand: string;
  cwd: string;
  cols: number;
  rows: number;
}

export async function runCreateCommand(options: CommandOptions): Promise<void> {
  const { sessionId } = await allocateSession({
    command: options.command,
    shellCommand: options.shellCommand,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
  });

  launchHost(sessionId);

  const home = resolveHome();
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
        const manifest = await readManifestIfExists(manifestPath(sessionDirectory));
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
