// Preload (`--import`) that makes every read of /proc/self/stat fail with
// ENOENT, as in a chroot without /proc, so the CLI cannot read its own
// session id.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const readFileSync = fs.readFileSync as (...args: unknown[]) => unknown;

fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
  if (path === '/proc/self/stat') {
    throw Object.assign(
      new Error("ENOENT: no such file or directory, open '/proc/self/stat'"),
      { errno: -2, code: 'ENOENT', syscall: 'open', path },
    );
  }
  return readFileSync(path, ...rest);
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
