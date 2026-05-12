import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcServer } from '../../../src/host/rpcServer.js';

let tempDir = '';

describe('RpcServer request abort handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-server-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('aborts the request context when the client socket closes', async () => {
    const socketFile = join(tempDir, 'rpc.sock');
    const handlerStarted = Promise.withResolvers<undefined>();
    const requestAborted = Promise.withResolvers<AbortSignal>();
    const server = new RpcServer(socketFile, {
      inspect: async (_params, context) => {
        handlerStarted.resolve(undefined);
        context.signal.addEventListener(
          'abort',
          () => {
            requestAborted.resolve(context.signal);
          },
          { once: true },
        );
        await requestAborted.promise;
        return {};
      },
    });
    await server.listen();

    const client = net.connect({ path: socketFile });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write(
      `${JSON.stringify({ id: 'request-1', method: 'inspect', params: {} })}\n`,
    );
    await handlerStarted.promise;
    client.destroy();

    try {
      const signal = await requestAborted.promise;
      expect(signal.aborted).toBe(true);
    } finally {
      await server.close();
    }
  });
});
