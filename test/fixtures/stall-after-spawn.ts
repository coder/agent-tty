// Preload (`--import`) for the session host only: right after node-pty
// spawns the program, the host blocks for AGENT_TTY_TEST_STALL_AFTER_SPAWN_MS,
// as a host does that a loaded machine does not schedule for a while. The
// program runs meanwhile, so one that exits at once is gone before the host
// reads its session token.
import { createRequire } from 'node:module';
import process from 'node:process';

if (process.argv.includes('_host')) {
  const stallMs = Number(process.env.AGENT_TTY_TEST_STALL_AFTER_SPAWN_MS);
  if (!Number.isInteger(stallMs) || stallMs <= 0) {
    throw new Error(
      'AGENT_TTY_TEST_STALL_AFTER_SPAWN_MS must be a positive integer',
    );
  }
  const require = createRequire(import.meta.url);
  const pty = require('node-pty') as {
    spawn: (...args: unknown[]) => unknown;
  };
  const spawn = pty.spawn;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  pty.spawn = (...args: unknown[]) => {
    const child = spawn(...args);
    Atomics.wait(cell, 0, 0, stallMs);
    return child;
  };
}
