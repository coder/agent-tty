import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import process from 'node:process';

// Models a command that throws an unexpected error and leaves a handle open:
// readFile rejects for the file named in AGENT_TTY_TEST_FAIL_READ, and a ref'd
// interval keeps the event loop alive until something calls process.exit().
const failName = process.env.AGENT_TTY_TEST_FAIL_READ;
if (failName !== undefined) {
  setInterval(() => undefined, 60_000);
  const fsPromises = createRequire(import.meta.url)(
    'node:fs/promises',
  ) as typeof import('node:fs/promises');
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
