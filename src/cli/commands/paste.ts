import { CliError } from '../errors.js';
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

export interface PasteResult {
  [key: string]: never;
}

interface CommandOptions {
  json: boolean;
  sessionId: string;
  text: string;
}

export async function runPasteCommand(options: CommandOptions): Promise<void> {
  if (options.text.length === 0) {
    throw new CliError('INVALID_INPUT', 'Text must not be empty.', {
      details: {
        text: options.text,
      },
    });
  }

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
    text: options.text,
  });

  const result: PasteResult = {};
  emitSuccess({
    command: 'paste',
    json: options.json,
    result,
    lines: ['Pasted text into session.'],
  });
}
