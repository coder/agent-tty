// Preload (`--import`) that makes /proc/self/stat show session id 0, as in a
// PID namespace whose session leader runs outside it (`unshare -p -f`, bwrap
// without --new-session).
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const readFileSync = fs.readFileSync as (...args: unknown[]) => unknown;

fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
  const text = readFileSync(path, ...rest);
  if (path !== '/proc/self/stat' || typeof text !== 'string') {
    return text;
  }
  // The command name can hold spaces, so count the fields from the last ')'.
  const close = text.lastIndexOf(')');
  const fields = text.slice(close + 2).split(' ');
  fields[3] = '0';
  return `${text.slice(0, close + 2)}${fields.join(' ')}`;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
