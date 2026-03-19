import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
import { invariant } from '../util/assert.js';

export interface PtyOptions {
  command: string[];
  cwd: string;
  cols: number;
  rows: number;
}

export function createPty(options: PtyOptions): IPty {
  const { command, cwd, cols, rows } = options;

  invariant(command.length > 0, 'PTY command must not be empty');
  invariant(Number.isInteger(cols) && cols > 0, 'PTY cols must be a positive integer');
  invariant(Number.isInteger(rows) && rows > 0, 'PTY rows must be a positive integer');

  return spawn(command[0]!, command.slice(1), {
    cwd,
    cols,
    rows,
  });
}
