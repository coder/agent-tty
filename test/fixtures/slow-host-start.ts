// Preload (`--import`) for the session host only: the host blocks for
// AGENT_TTY_TEST_HOST_START_STALL_MS before it starts, as a host does that a
// loaded machine does not schedule for a while. With
// AGENT_TTY_TEST_HOST_START_EXIT_FILE the host then writes the time in ms to
// that file and exits with 1, as a host does that fails to start.
import { writeFileSync } from 'node:fs';
import process from 'node:process';

if (process.argv.includes('_host')) {
  const stallMs = Number(process.env.AGENT_TTY_TEST_HOST_START_STALL_MS);
  if (!Number.isInteger(stallMs) || stallMs <= 0) {
    throw new Error(
      'AGENT_TTY_TEST_HOST_START_STALL_MS must be a positive integer',
    );
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
  const exitFile = process.env.AGENT_TTY_TEST_HOST_START_EXIT_FILE;
  if (exitFile !== undefined) {
    writeFileSync(exitFile, String(Date.now()));
    process.exit(1);
  }
}
