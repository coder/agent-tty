import { appendFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import process from 'node:process';

const exitFile = process.env.HOST_EXIT_FILE;

if (exitFile !== undefined && process.argv.includes('_host')) {
  const rmdir = fsPromises.rmdir;
  fsPromises.rmdir = async (path) => {
    if (
      typeof path === 'string' &&
      path.startsWith(`/tmp/agent-tty-${String(process.getuid?.())}/`)
    ) {
      appendFileSync(`${exitFile}.ebusy`, `${path}\n`);
      throw Object.assign(new Error(`EBUSY: resource busy, rmdir '${path}'`), {
        code: 'EBUSY',
        syscall: 'rmdir',
        path,
      });
    }
    await rmdir(path);
  };
  syncBuiltinESMExports();
  process.on('exit', (code) => {
    appendFileSync(exitFile, `${String(code)}\n`);
  });
}
