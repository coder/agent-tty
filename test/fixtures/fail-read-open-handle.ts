import type * as FsPromises from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import process from 'node:process';

function keepEventLoopAlive(): void {
  setInterval(() => undefined, 60_000);
}

function failReadFileNamed(failName: string): void {
  const fsPromises = createRequire(import.meta.url)(
    'node:fs/promises',
  ) as typeof FsPromises;
  const readFile = fsPromises.readFile as (...args: unknown[]) => unknown;
  fsPromises.readFile = ((path: unknown, ...rest: unknown[]) => {
    const name = basename(path instanceof URL ? path.pathname : String(path));
    if (name === failName) {
      return Promise.reject(new Error(`fixture: ${name} read failed`));
    }
    return readFile(path, ...rest);
  }) as typeof fsPromises.readFile;
  syncBuiltinESMExports();
}

const failName = process.env.AGENT_TTY_TEST_FAIL_READ;
if (failName !== undefined) {
  keepEventLoopAlive();
  failReadFileNamed(failName);
}
