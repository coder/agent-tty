import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import process from 'node:process';

// AGENT_TTY_TEST_CHROMIUM_FAILURES=<n> fails only the first n launches.
if (process.argv.includes('_host')) {
  const limit = process.env.AGENT_TTY_TEST_CHROMIUM_FAILURES;
  let failuresLeft = limit === undefined ? Infinity : Number(limit);
  const spawn = childProcess.spawn.bind(childProcess);
  childProcess.spawn = ((command: string, ...rest: unknown[]) => {
    if (/chrom|headless_shell/u.test(command) && failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('injected Chromium launch failure');
    }
    return (spawn as (...args: unknown[]) => unknown)(command, ...rest);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
}
