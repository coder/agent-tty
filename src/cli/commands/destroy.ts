import { spawn } from 'node:child_process';
import process from 'node:process';

import type { DestroyResult } from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import {
  cliRunsInsideProgramSession,
  destroySession,
} from '../../host/lifecycle.js';

interface CommandOptions {
  json: boolean;
  sessionId: string;
  force: boolean;
}

// The destroy kills the program's process group and ends the program, whose
// exit hangs up the jobs of its session. A CLI inside that session dies
// before it prints, so a copy in a new session does the destroy instead.
async function rerunInNewSession(): Promise<number> {
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    { detached: true, stdio: 'inherit' },
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
  if (await cliRunsInsideProgramSession(options.sessionId)) {
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
