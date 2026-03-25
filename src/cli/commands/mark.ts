import type { CommandContext } from '../context.js';
import type { MarkResult } from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { MarkResultSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

export type { MarkResult } from '../../protocol/messages.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  label: string;
}

export async function runMarkCommand(options: CommandOptions): Promise<void> {
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

  if (manifest.status === 'destroyed') {
    throw makeCliError(ERROR_CODES.SESSION_ALREADY_DESTROYED, {
      message: `Session "${options.sessionId}" is already destroyed.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  if (manifest.status !== 'running') {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: `Session "${options.sessionId}" is not running.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  const rawResult: unknown = await sendRpc(
    socketPath(sessionDirectory),
    'mark',
    {
      label: options.label,
    },
  );
  const parsedResult = MarkResultSchema.safeParse(rawResult);
  if (!parsedResult.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response from host',
      details: { issues: parsedResult.error.issues },
    });
  }

  const result: MarkResult = { seq: parsedResult.data.seq };
  emitSuccess({
    command: 'mark',
    json: options.json,
    result,
    lines: [`Marker set at seq ${String(result.seq)}.`],
  });
}
