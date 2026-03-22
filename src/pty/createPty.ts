import process from 'node:process';

import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
import { invariant } from '../util/assert.js';

export interface PtyOptions {
  command: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  term: string;
}

export function createPty(options: PtyOptions): IPty {
  const { command, cwd, cols, rows, env, term } = options;

  invariant(command.length > 0, 'PTY command must not be empty');
  invariant(
    Number.isInteger(cols) && cols > 0,
    'PTY cols must be a positive integer',
  );
  invariant(
    Number.isInteger(rows) && rows > 0,
    'PTY rows must be a positive integer',
  );
  invariant(term.length > 0, 'PTY term must not be empty');

  const file = command[0];
  invariant(file !== undefined, 'PTY command must have an executable');

  for (const [entryKey, entryValue] of Object.entries(env)) {
    invariant(entryKey.length > 0, 'PTY env keys must not be empty');
    invariant(typeof entryValue === 'string', 'PTY env values must be strings');
  }

  return spawn(file, command.slice(1), {
    cwd,
    cols,
    rows,
    env: {
      ...process.env,
      ...env,
      TERM: term,
    },
  });
}
