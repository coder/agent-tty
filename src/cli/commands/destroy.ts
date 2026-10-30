import { spawn } from 'node:child_process';
import process from 'node:process';

import type { DestroyResult } from '../../protocol/messages.js';

import { emitSuccess } from '../output.js';
import {
  destroySession,
  isInsideSessionProcessGroup,
} from '../../host/lifecycle.js';

interface CommandOptions {
  json: boolean;
  sessionId: string;
  force: boolean;
}

// The destroy kills the program's process group, and the kernel hangs up
// the group when the program exits, so a CLI inside that group dies before
// it prints. A copy in a new session does the destroy and prints instead.
async function rerunOutsideProcessGroup(): Promise<number> {
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
  if (await isInsideSessionProcessGroup(options.sessionId)) {
    process.exitCode = await rerunOutsideProcessGroup();
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
