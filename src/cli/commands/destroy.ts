import { spawn } from 'node:child_process';
import process from 'node:process';

import type { DestroyResult } from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import {
  cliRunsInsideProgramSession,
  destroySession,
} from '../../host/lifecycle.js';

const RERUN_MARKER = 'AGENT_TTY_DESTROY_RERUN';

interface CommandOptions {
  json: boolean;
  sessionId: string;
  force: boolean;
}

// The destroy kills the program's process group and ends the program, whose
// exit hangs up the jobs of its session. A CLI inside that session dies
// before it prints, so a copy in a new session does the destroy instead.
// The copy runs outside the session, so it does not get the session's id.
// RERUN_MARKER tells the copy to skip the check, so whatever ps shows, a
// copy never starts another copy.
async function rerunInNewSession(): Promise<number> {
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      detached: true,
      env: {
        ...process.env,
        AGENT_TTY_SESSION_ID: undefined,
        [RERUN_MARKER]: '1',
      },
      stdio: 'inherit',
    },
  );
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

export async function runDestroyCommand(
  options: CommandOptions,
): Promise<void> {
  if (
    process.env[RERUN_MARKER] !== '1' &&
    (await cliRunsInsideProgramSession(options.sessionId))
  ) {
    process.exitCode = await rerunInNewSession();
    return;
  }

  await destroySession(options.sessionId, options.force);

  const result: DestroyResult = {
    sessionId: options.sessionId,
    destroyed: true,
  };

  emitSuccess({
    command: 'destroy',
    json: options.json,
    result,
    lines: [`Session destroyed: ${options.sessionId}`],
  });
}
