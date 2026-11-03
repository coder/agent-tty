import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendRpc } from '../../../src/host/rpcClient.js';
import { RpcServer } from '../../../src/host/rpcServer.js';
import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';

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

describe('RpcServer CliError responses', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-server-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  async function rejectionFrom(handlerError: Error): Promise<unknown> {
    const socketFile = join(tempDir, 'rpc.sock');
    const server = new RpcServer(socketFile, {
      inspect: () => Promise.reject(handlerError),
    });
    await server.listen();
    try {
      return await sendRpc(socketFile, 'inspect', {}, 5_000).catch(
        (error: unknown) => error,
      );
    } finally {
      await server.close();
    }
  }

  it('carries the code, message and details of a CliError to the client', async () => {
    const error = await rejectionFrom(
      makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
        message: 'Artifacts path /run/artifacts is not a folder.',
        details: { path: '/run/artifacts', errno: 'ELOOP' },
      }),
    );

    expect(error).toMatchObject({
      code: 'STORAGE_WRITE_ERROR',
      message: 'Artifacts path /run/artifacts is not a folder.',
      details: { path: '/run/artifacts', errno: 'ELOOP' },
    });
  });

  it('gives an error that is not a CliError as RPC_ERROR without details', async () => {
    const error = await rejectionFrom(new Error('renderer failed'));

    expect(error).toMatchObject({
      code: 'RPC_ERROR',
      message: 'renderer failed',
      details: {},
    });
  });
});
