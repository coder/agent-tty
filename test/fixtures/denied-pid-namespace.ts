// Preload (`--import`) that makes every read of a /proc/<pid>/ns/pid link fail
// with EACCES, as a /proc that shows the autogroup but not the namespace does.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const readlinkSync = fs.readlinkSync as (...args: unknown[]) => unknown;

fs.readlinkSync = ((path: unknown, ...rest: unknown[]) => {
  if (typeof path === 'string' && /^\/proc\/(\d+|self)\/ns\/pid$/.test(path)) {
    throw Object.assign(
      new Error(`EACCES: permission denied, readlink '${path}'`),
      {
        errno: -13,
        code: 'EACCES',
        syscall: 'readlink',
        path,
      },
    );
  }
  return readlinkSync(path, ...rest);
}) as typeof fs.readlinkSync;
syncBuiltinESMExports();
