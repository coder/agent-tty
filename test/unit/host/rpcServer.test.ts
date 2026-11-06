import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { setTimeout } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliError } from '../../../src/cli/errors.js';
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

describe('RpcServer request ids', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-server-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('rejects a request id over 128 characters without echoing it', async () => {
    const socketFile = join(tempDir, 'rpc.sock');
    const inspect = vi.fn(() => Promise.resolve({}));
    const server = new RpcServer(socketFile, { inspect });
    await server.listen();
    const client = net.connect({ path: socketFile });
    client.setEncoding('utf8');
    let received = '';
    client.on('data', (chunk: string) => {
      received += chunk;
    });
    const ended = new Promise<void>((resolve, reject) => {
      client.once('end', resolve);
      client.once('error', reject);
    });

    try {
      client.write(
        `${JSON.stringify({ id: 'x'.repeat(129), method: 'inspect', params: {} })}\n`,
      );
      await ended;

      expect(JSON.parse(received)).toMatchObject({
        id: 'unknown',
        ok: false,
        error: { code: 'RPC_ERROR' },
      });
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      client.destroy();
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

  it.each<[string, () => Record<string, unknown>]>([
    [
      'too large for one response',
      () => ({
        issues: Array.from({ length: 50_000 }, (_, index) => ({
          path: ['artifacts', index],
          message: 'Required',
        })),
      }),
    ],
    ['a BigInt', () => ({ size: 1n })],
    [
      'a circular object',
      () => {
        const details: Record<string, unknown> = {};
        details.self = details;
        return details;
      },
    ],
    [
      'behind a throwing getter',
      () =>
        Object.defineProperty({}, 'size', {
          enumerable: true,
          get: () => {
            throw new Error('size is not readable');
          },
        }),
    ],
    ['a toJSON that returns undefined', () => ({ toJSON: () => undefined })],
    ['a toJSON that returns a string', () => ({ toJSON: () => 'size: 1' })],
    ['a toJSON that returns an array', () => ({ toJSON: () => ['size', 1] })],
  ])(
    'keeps the code and message but drops details that are %s',
    async (_case, makeDetails) => {
      const error = await rejectionFrom(
        makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
          message: 'Artifact manifest is invalid.',
          details: makeDetails(),
        }),
      );

      expect(error).toMatchObject({
        code: 'MANIFEST_VALIDATION_ERROR',
        message: 'Artifact manifest is invalid.',
      });
      expect((error as CliError).details).toEqual({});
    },
  );

  it('gives an error that is not a CliError as RPC_ERROR without details', async () => {
    const error = await rejectionFrom(new Error('renderer failed'));

    expect(error).toMatchObject({
      code: 'RPC_ERROR',
      message: 'renderer failed',
      details: {},
    });
  });

  // A control character takes 6 characters in JSON (\u0001), the largest
  // escape, so this message is the worst case for the response size.
  const hugeMessage = '\u0001'.repeat(1_100_000);

  it('shortens a huge CliError message and keeps its code and details', async () => {
    const details = { blob: 'x'.repeat(65_000) };
    const error = await rejectionFrom(
      makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
        message: hugeMessage,
        details,
      }),
    );

    expect(error).toMatchObject({ code: 'STORAGE_WRITE_ERROR', details });
    const { message } = error as CliError;
    expect(message.length).toBeLessThan(70_000);
    expect(message.startsWith('\u0001'.repeat(60_000))).toBe(true);
    expect(message.endsWith('[message truncated]')).toBe(true);
  });

  it('shortens a huge message of an error that is not a CliError', async () => {
    const error = await rejectionFrom(new Error(hugeMessage));

    expect(error).toMatchObject({ code: 'RPC_ERROR' });
    const { details, message } = error as CliError;
    expect(details).toEqual({});
    expect(message.length).toBeLessThan(70_000);
    expect(message.startsWith('\u0001'.repeat(60_000))).toBe(true);
    expect(message.endsWith('[message truncated]')).toBe(true);
  });

  it('does not cut a surrogate pair in half when it shortens a message', async () => {
    const error = await rejectionFrom(new Error(`a${'😀'.repeat(40_000)}`));

    expect((error as CliError).message).toBe(
      `a${'😀'.repeat(32_757)} [message truncated]`,
    );
  });

  it('answers RPC_ERROR when building the error response throws', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handlerError = new Error('placeholder');
    Object.defineProperty(handlerError, 'message', {
      get: () => {
        throw new Error('message is not readable');
      },
    });

    try {
      const error = await rejectionFrom(handlerError);

      expect(error).toMatchObject({
        code: 'RPC_ERROR',
        message: 'RPC request handling failed unexpectedly.',
        details: {},
      });
      expect(consoleError).toHaveBeenCalledWith(
        'RPC request handling failed unexpectedly:',
        expect.objectContaining({ message: 'message is not readable' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('RpcServer large success responses', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-server-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  async function textSnapshotFrom(text: string): Promise<unknown> {
    const socketFile = join(tempDir, 'rpc.sock');
    const server = new RpcServer(socketFile, {
      snapshot: () =>
        Promise.resolve({
          format: 'text',
          sessionId: 'session-1',
          capturedAtSeq: 1,
          cols: 80,
          rows: 24,
          cursorRow: 0,
          cursorCol: 0,
          text,
        }),
    });
    await server.listen();
    try {
      return await sendRpc(
        socketFile,
        'snapshot',
        { format: 'text' },
        20_000,
      ).catch((error: unknown) => error);
    } finally {
      await server.close();
    }
  }

  it('returns a success response larger than 1 MiB', async () => {
    const result = await textSnapshotFrom('x'.repeat(2_000_000));

    expect(result).toMatchObject({ format: 'text' });
    expect((result as { text: string }).text).toHaveLength(2_000_000);
  });

  it('scans each chunk of a large response for the newline only once', async () => {
    // A socket read gives at most 64 KiB, so this response comes in 60 or more
    // chunks. Scanning the whole buffer after each chunk would read the
    // response about 30 times; scanning each new chunk reads it once.
    // oxlint-disable-next-line typescript/unbound-method -- the spy below calls it with nativeIndexOf.call(this, ...).
    const nativeIndexOf = String.prototype.indexOf;
    let newlineScanChars = 0;
    const indexOf = vi
      .spyOn(String.prototype, 'indexOf')
      .mockImplementation(function (
        this: string,
        searchString: string,
        position?: number,
      ): number {
        if (searchString === '\n') {
          newlineScanChars += this.length;
        }
        return nativeIndexOf.call(this, searchString, position);
      });

    let result: unknown;
    try {
      result = await textSnapshotFrom('x'.repeat(4_000_000));
    } finally {
      indexOf.mockRestore();
    }

    expect((result as { text: string }).text).toHaveLength(4_000_000);
    expect(newlineScanChars).toBeLessThan(2 * 4_000_000);
  });

  it(
    'refuses a success response over 64 MiB with PROTOCOL_ERROR',
    { timeout: 30_000 },
    async () => {
      const error = await textSnapshotFrom('x'.repeat(67_108_864));

      expect(error).toMatchObject({
        code: 'PROTOCOL_ERROR',
        details: { maxResponseChars: 67_108_864 },
      });
      const { details, message } = error as CliError;
      const responseChars = details.responseChars as number;
      expect(responseChars).toBeGreaterThan(67_108_864);
      expect(message).toBe(
        `RPC response takes ${String(responseChars)} characters, over the 67108864-character limit.`,
      );
    },
  );
});

describe('RpcServer keep-alive', () => {
  // A success result of the `snapshot` method, which is the smallest.
  const snapshotResult = {
    format: 'text',
    sessionId: 'session-1',
    capturedAtSeq: 1,
    cols: 80,
    rows: 24,
    cursorRow: 0,
    cursorCol: 0,
    text: 'done',
  };
  const WAIT_FOR_KEEP_ALIVE_MS = 800;
  const KEEP_ALIVE_INTERVAL_MS = 250;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-server-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('keeps a client waiting for as long as the handler reports progress', async () => {
    const socketFile = join(tempDir, 'rpc.sock');
    const server = new RpcServer(socketFile, {
      snapshot: async (_params, context) => {
        // 1,250 ms in all, which is more than the 800 ms that the client waits
        // for a byte, with a byte every 250 ms.
        for (let round = 0; round < 5; round += 1) {
          await setTimeout(KEEP_ALIVE_INTERVAL_MS);
          context.keepAlive();
        }
        return snapshotResult;
      },
    });
    await server.listen();

    try {
      await expect(
        sendRpc(
          socketFile,
          'snapshot',
          { format: 'text' },
          WAIT_FOR_KEEP_ALIVE_MS,
        ),
      ).resolves.toMatchObject({ format: 'text', text: 'done' });
    } finally {
      await server.close();
    }
  });

  it('fails a client with HOST_TIMEOUT once the handler stops reporting progress', async () => {
    const socketFile = join(tempDir, 'rpc.sock');
    const server = new RpcServer(socketFile, {
      snapshot: async (_params, context) => {
        context.keepAlive();
        await setTimeout(KEEP_ALIVE_INTERVAL_MS);
        context.keepAlive();
        // The handler hangs until the client gives up.
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return snapshotResult;
      },
    });
    await server.listen();

    try {
      const startedAt = performance.now();
      const error = await sendRpc(
        socketFile,
        'snapshot',
        { format: 'text' },
        WAIT_FOR_KEEP_ALIVE_MS,
      ).catch((rejection: unknown) => rejection);
      const elapsedMs = performance.now() - startedAt;

      expect(error).toMatchObject({ code: 'HOST_TIMEOUT' });
      // The wait started over at the last byte, 250 ms in.
      expect(elapsedMs).toBeGreaterThanOrEqual(
        KEEP_ALIVE_INTERVAL_MS + WAIT_FOR_KEEP_ALIVE_MS - 50,
      );
    } finally {
      await server.close();
    }
  });

  it('does not cut a large response when the handler reports progress after it returned', async () => {
    const socketFile = join(tempDir, 'rpc.sock');
    const text = 'x'.repeat(4_000_000);
    const server = new RpcServer(socketFile, {
      snapshot: (_params, context) => {
        // The response is on its way when this runs. A byte now would be a
        // write after the end of the socket, which destroys the socket with
        // part of the response still unsent.
        setImmediate(() => {
          context.keepAlive();
        });
        return Promise.resolve({ ...snapshotResult, text });
      },
    });
    await server.listen();

    try {
      await expect(
        sendRpc(socketFile, 'snapshot', { format: 'text' }, 20_000),
      ).resolves.toMatchObject({ format: 'text', text });
    } finally {
      await server.close();
    }
  });

  it('sends only spaces ahead of the response line, so that an older client parses it', async () => {
    const socketFile = join(tempDir, 'rpc.sock');
    const server = new RpcServer(socketFile, {
      snapshot: async (_params, context) => {
        context.keepAlive();
        await setTimeout(20);
        context.keepAlive();
        await setTimeout(20);
        context.keepAlive();
        return snapshotResult;
      },
    });
    await server.listen();

    try {
      const client = net.connect({ path: socketFile });
      client.setEncoding('utf8');
      let received = '';
      client.on('data', (chunk: string) => {
        received += chunk;
      });
      const ended = new Promise<void>((resolve, reject) => {
        client.once('end', resolve);
        client.once('error', reject);
      });
      client.write(
        `${JSON.stringify({ id: 'request-1', method: 'snapshot', params: { format: 'text' } })}\n`,
      );
      await ended;

      // The first line of the bytes is what a client before the keep-alive
      // gave to JSON.parse.
      const [line, rest] = received.split('\n');
      expect(line?.startsWith('   {')).toBe(true);
      expect(rest).toBe('');
      expect(JSON.parse(line ?? '')).toMatchObject({
        id: 'request-1',
        ok: true,
        result: { text: 'done' },
      });
    } finally {
      await server.close();
    }
  });
});
