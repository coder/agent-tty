// Preload (`--import`) that makes every read of /proc/<pid>/autogroup fail
// with EACCES, as a hardened /proc does for a process that it still lists.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const readFileSync = fs.readFileSync as (...args: unknown[]) => unknown;

fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
  if (typeof path === 'string' && /^\/proc\/\d+\/autogroup$/.test(path)) {
    throw Object.assign(
      new Error(`EACCES: permission denied, open '${path}'`),
      {
        errno: -13,
        code: 'EACCES',
        syscall: 'open',
        path,
      },
    );
  }
  return readFileSync(path, ...rest);
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
