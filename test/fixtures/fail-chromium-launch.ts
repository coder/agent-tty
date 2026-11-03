import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import process from 'node:process';

if (process.argv.includes('_host')) {
  const spawn = childProcess.spawn.bind(childProcess);
  childProcess.spawn = ((command: string, ...rest: unknown[]) => {
    if (/chrom|headless_shell/u.test(command)) {
      throw new Error('injected Chromium launch failure');
    }
    return (spawn as (...args: unknown[]) => unknown)(command, ...rest);
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
}
