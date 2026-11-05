// Preload (`--import`) for a `create` process: once the create-failed marker
// exists, every read of the session's session.json fails with EACCES, as an
// unreadable manifest does. The host inherits NODE_OPTIONS and skips this.
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname } from 'node:path';
import process from 'node:process';

if (process.argv.includes('create') && !process.argv.includes('_host')) {
  const readFile = fsp.readFile as (...args: unknown[]) => Promise<unknown>;
  fsp.readFile = ((path: unknown, ...rest: unknown[]) => {
    const file = path instanceof URL ? path.pathname : String(path);
    if (
      basename(file) === 'session.json' &&
      existsSync(`${dirname(file)}/create-failed`)
    ) {
      return Promise.reject(
        Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
          code: 'EACCES',
          syscall: 'open',
          path: file,
        }),
      );
    }
    return readFile(path, ...rest);
  }) as typeof fsp.readFile;
  syncBuiltinESMExports();
}
