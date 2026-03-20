import { emitSuccess } from '../output.js';
import { listSessions } from '../../host/lifecycle.js';
import { resolveHome } from '../../storage/home.js';

export interface ListResult {
  sessions: Array<{
    sessionId: string;
    status: string;
    command: string[];
    createdAt: string;
  }>;
}

interface CommandOptions {
  json: boolean;
  all: boolean;
}

export async function runListCommand(options: CommandOptions): Promise<void> {
  const home = resolveHome();
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
