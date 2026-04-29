import type { CommandContext } from '../context.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import type { RunResult } from '../../protocol/messages.js';
import { RunResultSchema } from '../../protocol/messages.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
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

  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Timeout must be a positive integer in milliseconds',
      details: {
        timeout: options.timeout,
      },
    });
  }

  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

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
    target.socketPath,
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
