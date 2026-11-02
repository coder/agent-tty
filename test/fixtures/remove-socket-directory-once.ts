import { rmdirSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { dirname } from 'node:path';
import process from 'node:process';

const removeBefore = process.env.REMOVE_SOCKET_DIRECTORY_BEFORE ?? 'bind';
let removed = false;

if (removeBefore === 'bind') {
  const prototype = net.Server.prototype as unknown as {
    listen: (this: net.Server, ...args: unknown[]) => net.Server;
  };
  const listen = prototype.listen;
  prototype.listen = function (this: net.Server, ...args: unknown[]) {
    const [path] = args;
    if (!removed && typeof path === 'string') {
      removed = true;
      rmdirSync(dirname(path));
    }
    return listen.apply(this, args);
  };
} else {
  const chmod = fsPromises.chmod;
  fsPromises.chmod = async (path, mode) => {
    if (
      !removed &&
      typeof path === 'string' &&
      path.startsWith('/tmp/agent-tty/')
    ) {
      removed = true;
      rmdirSync(path);
    }
    await chmod(path, mode);
  };
  syncBuiltinESMExports();
}
