import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import {
  isCommandableSessionStatus,
  isDestroyedSessionStatus,
} from '../../protocol/sessionStatusPolicy.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

const ALLOWED_SIGNALS = [
  'SIGTERM',
  'SIGINT',
  'SIGKILL',
  'SIGHUP',
  'SIGUSR1',
  'SIGUSR2',
] as const;

export interface SignalResult {
  signal: string;
  delivered: boolean;
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  signal: string;
}

export async function runSignalCommand(options: CommandOptions): Promise<void> {
  const home = options.context.home;
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

  if (isDestroyedSessionStatus(manifest.status)) {
    throw makeCliError(ERROR_CODES.SESSION_ALREADY_DESTROYED, {
      message: `Session "${options.sessionId}" is already destroyed.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  if (!isCommandableSessionStatus(manifest.status)) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: `Session "${options.sessionId}" is not running.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  if (
    !ALLOWED_SIGNALS.includes(
      options.signal as (typeof ALLOWED_SIGNALS)[number],
    )
  ) {
    throw makeCliError(ERROR_CODES.INVALID_SIGNAL, {
      message: `Signal must be one of: ${ALLOWED_SIGNALS.join(', ')}.`,
      details: {
        signal: options.signal,
      },
    });
  }

  await sendRpc(socketPath(sessionDirectory), 'signal', {
    signal: options.signal,
  });

  const result: SignalResult = {
    signal: options.signal,
    delivered: true,
  };
  emitSuccess({
    command: 'signal',
    json: options.json,
    result,
    lines: [`Signal ${options.signal} delivered to session.`],
  });
}
