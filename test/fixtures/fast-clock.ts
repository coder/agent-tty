// Preload (`--import`) for the CLI only, not the session host: the monotonic
// clock, `performance.now()`, runs AGENT_TTY_TEST_CLOCK_FACTOR times as fast.
// A create that waits for a host with a deadline on that clock gives up
// sooner, as it does on a host that never listens, and its timers still run
// in real time.
import process from 'node:process';

if (!process.argv.includes('_host')) {
  const factor = Number(process.env.AGENT_TTY_TEST_CLOCK_FACTOR);
  if (!Number.isInteger(factor) || factor <= 0) {
    throw new Error('AGENT_TTY_TEST_CLOCK_FACTOR must be a positive integer');
  }
  const now = performance.now.bind(performance);
  const origin = now();
  performance.now = () => origin + (now() - origin) * factor;
}
