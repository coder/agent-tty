import { rmdirSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';

const listen = net.Server.prototype.listen;
let removed = false;

net.Server.prototype.listen = function (
  this: net.Server,
  ...args: unknown[]
): net.Server {
  const [path] = args;
  if (!removed && typeof path === 'string') {
    removed = true;
    rmdirSync(dirname(path));
  }
  return listen.apply(this, args as Parameters<typeof listen>);
} as typeof listen;
