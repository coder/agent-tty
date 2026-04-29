import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import type { RunResult } from '../../protocol/messages.js';
import { RunResultSchema } from '../../protocol/messages.js';
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
import { resolveCommandInputText } from './inputSource.js';

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  sessionId: string;
  text: string | undefined;
  file?: string;
  timeout: number;
  wait: boolean;
}

export async function runRunCommand(options: CommandOptions): Promise<void> {
  const command = await resolveCommandInputText({
    commandName: 'run',
    text: options.text,
    file: options.file,
  });

  if (command.length === 0) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Command text must not be empty.',
      details: {
        command,
      },
    });
  }

  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Timeout must be a positive integer in milliseconds',
      details: {
        timeout: options.timeout,
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

  const noWait = !options.wait;
  const rpcParams: Record<string, unknown> = {
    command,
    noWait,
  };

  if (!noWait && options.timeout > 0) {
    rpcParams.timeoutMs = options.timeout;
  }

  const rpcTimeoutMs = noWait ? 10_000 : options.timeout + 10_000;
  const rawResult = await sendRpc(
    socketPath(sessionDirectory),
    'run',
    rpcParams,
    rpcTimeoutMs,
  );

  const parsed = RunResultSchema.safeParse(rawResult);
  if (!parsed.success) {
    throw makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
      message: 'Unexpected response shape from the session host.',
      details: {
        errors: parsed.error.issues,
        rawResult,
      },
    });
  }

  const result: RunResult = parsed.data;
  const lines: string[] = [];

  if (noWait) {
    lines.push(`Command injected into session (seq=${String(result.seq)}).`);
  } else if (result.completed) {
    lines.push(
      `Command completed (seq=${String(result.seq)}, ${String(result.durationMs)}ms).`,
    );
  } else if (result.timedOut) {
    lines.push(
      `Command timed out after ${String(result.durationMs)}ms (seq=${String(result.seq)}).`,
    );
  }

  emitSuccess({
    command: 'run',
    json: options.json,
    result,
    lines,
  });
}
