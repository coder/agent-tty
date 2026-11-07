// Preload (`--import`) for the CLI only, not the session host: the first
// `inspect` request that the CLI writes fails with EPIPE, as a write to a
// host does that closes its server at that moment. The write never reaches
// the host. The file named by AGENT_TTY_TEST_EPIPE_FLAG records that the
// failure happened.
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import process from 'node:process';

if (!process.argv.includes('_host')) {
  const flag = process.env.AGENT_TTY_TEST_EPIPE_FLAG;
  if (flag === undefined || flag.length === 0) {
    throw new Error('AGENT_TTY_TEST_EPIPE_FLAG must name a file');
  }
  // oxlint-disable-next-line typescript/unbound-method -- the patch below calls it with write.apply(this, args).
  const write = net.Socket.prototype.write as (
    this: net.Socket,
    ...args: unknown[]
  ) => boolean;
  let failed = false;
  net.Socket.prototype.write = function (
    this: net.Socket,
    ...args: unknown[]
  ): boolean {
    const [chunk] = args;
    if (
      !failed &&
      typeof chunk === 'string' &&
      chunk.includes('"method":"inspect"')
    ) {
      failed = true;
      writeFileSync(flag, '');
      queueMicrotask(() => {
        this.destroy(
          Object.assign(new Error('write EPIPE'), {
            code: 'EPIPE',
            syscall: 'write',
          }),
        );
      });
      return true;
    }
    return write.apply(this, args);
  } as typeof net.Socket.prototype.write;
}
