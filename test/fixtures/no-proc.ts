// Preload (`--import`) that hides /proc from this process, as in a chroot or
// a container without a mounted /proc.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function underProc(path: unknown): boolean {
  return (
    typeof path === 'string' && (path === '/proc' || path.startsWith('/proc/'))
  );
}

function missing(path: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${path}'`),
    { errno: -2, code: 'ENOENT', syscall: 'open', path },
  );
}

for (const name of ['readFileSync', 'readdirSync', 'readlinkSync'] as const) {
  const original = fs[name] as (...args: unknown[]) => unknown;
  (fs as unknown as Record<string, unknown>)[name] = (
    path: unknown,
    ...rest: unknown[]
  ) => {
    if (underProc(path)) {
      throw missing(path as string);
    }
    return original(path, ...rest);
  };
}
const existsSync = fs.existsSync;
fs.existsSync = (path) => !underProc(path) && existsSync(path);
syncBuiltinESMExports();
