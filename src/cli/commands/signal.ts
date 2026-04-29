import type { CommandContext } from '../context.js';

import { resolveCommandTarget } from '../commandTarget.js';
import { emitSuccess } from '../output.js';
import { sendRpc } from '../../host/rpcClient.js';
import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';

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
  const target = await resolveCommandTarget({
    home: options.context.home,
    sessionId: options.sessionId,
  });

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

  await sendRpc(target.socketPath, 'signal', {
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
