import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { readManifestIfExists } from '../../storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';
import { resolveCommandInputText } from './inputSource.js';

export interface PasteResult {
  [key: string]: never;
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  text: string | undefined;
  file?: string;
}

export async function runPasteCommand(options: CommandOptions): Promise<void> {
  const text = await resolveCommandInputText({
    commandName: 'paste',
    text: options.text,
    file: options.file,
  });

  if (text.length === 0) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Text must not be empty.',
      details: {
        text,
      },
    });
  }

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

  if (manifest.status !== 'running') {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      message: `Session "${options.sessionId}" is not running.`,
      details: {
        sessionId: options.sessionId,
        status: manifest.status,
      },
    });
  }

  await sendRpc(socketPath(sessionDirectory), 'paste', {
    text,
  });

  const result: PasteResult = {};
  emitSuccess({
    command: 'paste',
    json: options.json,
    result,
    lines: ['Pasted text into session.'],
  });
}
