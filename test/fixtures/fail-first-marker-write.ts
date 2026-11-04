// Preload (`--import`) for a `create` process: the first write of the
// create-failed marker's temp file fails with EIO, as a write that an
// antivirus lock blocks once does. The host inherits NODE_OPTIONS and skips
// this.
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import process from 'node:process';

if (process.argv.includes('create') && !process.argv.includes('_host')) {
  const writeFile = fsp.writeFile as (...args: unknown[]) => Promise<void>;
  let failed = false;
  fsp.writeFile = ((path: unknown, ...rest: unknown[]) => {
    const file = path instanceof URL ? path.pathname : String(path);
    if (!failed && basename(file).startsWith('create-failed.tmp-')) {
      failed = true;
      return Promise.reject(
        Object.assign(new Error(`EIO: i/o error, open '${file}'`), {
          code: 'EIO',
          syscall: 'open',
          path: file,
        }),
      );
    }
    return writeFile(path, ...rest);
  }) as typeof fsp.writeFile;
  syncBuiltinESMExports();
}
