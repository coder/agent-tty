import type * as Os from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const os = createRequire(import.meta.url)('node:os') as typeof Os;
const homedir = os.homedir;

function calledFromResolveHome(): boolean {
  return new Error().stack?.includes('/src/storage/home.ts') === true;
}

os.homedir = () => {
  if (calledFromResolveHome()) {
    throw new Error('fixture: homedir failed');
  }
  return homedir();
};
syncBuiltinESMExports();

export const openHandle = setInterval(() => undefined, 60_000);
