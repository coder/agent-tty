import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import { listSessions, type SessionSummary } from '../../host/lifecycle.js';

export interface ListResult {
  sessions: SessionSummary[];
}

interface CommandOptions {
  context: CommandContext;
  json: boolean;
  all: boolean;
}

export async function runListCommand(options: CommandOptions): Promise<void> {
  const home = options.context.home;
  const sessions = await listSessions(home, options.all);
  const lines = sessions.map(
    (session) =>
      `${session.sessionId}  ${session.status}  ${session.command.join(' ')}`,
  );

  emitSuccess({
    command: 'list',
    json: options.json,
    result: { sessions },
    lines,
  });
}
