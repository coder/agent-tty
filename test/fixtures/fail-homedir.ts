import type * as Os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';

// Node and tsx also call os.homedir() at startup, so only the Home lookup in
// src/storage/home.ts fails. The interval keeps the event loop alive.
const os = createRequire(import.meta.url)('node:os') as typeof Os;
const homedir = os.homedir;
os.homedir = () => {
  if (new Error().stack?.includes('/src/storage/home.ts') === true) {
    throw new Error('fixture: homedir failed');
  }
  return homedir();
};
syncBuiltinESMExports();
setInterval(() => undefined, 60_000);
