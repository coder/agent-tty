import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendRpc } from '../../../src/host/rpcClient.js';

let tempDir = '';

describe('sendRpc abort handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-client-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('rejects before opening a socket when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);

    await expect(
      sendRpc(
        join(tempDir, 'missing.sock'),
        'inspect',
        {},
        5_000,
        controller.signal,
      ),
    ).rejects.toThrow(reason);
  });

  it('destroys an in-flight socket when the signal aborts', async () => {
    const socketFile = join(tempDir, 'rpc.sock');
    const connected = Promise.withResolvers<net.Socket>();
    const serverSocketClosed = Promise.withResolvers<undefined>();
    const server = net.createServer((socket) => {
      connected.resolve(socket);
      socket.once('close', () => {
        serverSocketClosed.resolve(undefined);
      });
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketFile, () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const controller = new AbortController();
      const reason = new Error('client cancelled');
      const request = sendRpc(
        socketFile,
        'inspect',
        {},
        5_000,
        controller.signal,
      );
      const serverSocket = await connected.promise;

      controller.abort(reason);

      await expect(request).rejects.toThrow(reason);
      await serverSocketClosed.promise;
      expect(serverSocket.destroyed).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
