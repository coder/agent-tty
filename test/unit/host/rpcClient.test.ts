import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What lstat shows for a path, instead of the file system.
const lstatHooks = vi.hoisted(() => ({
  entries: new Map<
    string,
    { kind: 'directory' | 'socket' | 'symlink'; uid: number; mode: number }
  >(),
  missing: new Set<string>(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const lstat = (async (path: string, ...rest: unknown[]) => {
    if (lstatHooks.missing.has(path)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    const entry = lstatHooks.entries.get(path);
    if (entry === undefined) {
      return await (actual.lstat as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
    }
    return {
      uid: entry.uid,
      mode: entry.mode,
      isDirectory: () => entry.kind === 'directory',
      isSocket: () => entry.kind === 'socket',
      isSymbolicLink: () => entry.kind === 'symlink',
    };
  }) as typeof actual.lstat;
  return { ...actual, lstat };
});

import type * as FsPromises from 'node:fs/promises';

import { sendRpc } from '../../../src/host/rpcClient.js';
import {
  legacySocketPath,
  sessionDir,
  socketPath,
  socketRootDirectory,
} from '../../../src/storage/sessionPaths.js';

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

describe('sendRpc wait for the host', () => {
  const WAIT_MS = 800;
  const SHORT_WAIT_MS = 100;
  const BYTE_INTERVAL_MS = 250;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-client-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  // A host that answers `ping` after `bytes` spaces, one every 250 ms.
  async function listen(bytes: number): Promise<net.Server> {
    const socketFile = join(tempDir, 'rpc.sock');
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.once('data', (request: Buffer) => {
        const { id } = JSON.parse(request.toString('utf8')) as { id: string };
        void (async () => {
          for (let sent = 0; sent < bytes; sent += 1) {
            await setTimeout(BYTE_INTERVAL_MS);
            socket.write(' ');
          }
          await setTimeout(BYTE_INTERVAL_MS);
          socket.end(
            `${JSON.stringify({ id, ok: true, result: { ok: 1 } })}\n`,
          );
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketFile, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  }

  async function close(server: net.Server): Promise<void> {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  it('waits again after each byte of the host, so a slow host that sends bytes can take longer than the wait', async () => {
    // The answer comes after 1,500 ms, and a byte comes every 250 ms.
    const server = await listen(5);
    try {
      await expect(
        sendRpc(join(tempDir, 'rpc.sock'), 'ping', {}, WAIT_MS),
      ).resolves.toEqual({ ok: 1 });
    } finally {
      await close(server);
    }
  });

  it('fails with HOST_TIMEOUT after the wait without a byte', async () => {
    // The answer comes after 250 ms with no byte before it.
    const server = await listen(0);
    try {
      const error = await sendRpc(
        join(tempDir, 'rpc.sock'),
        'ping',
        {},
        SHORT_WAIT_MS,
      ).catch((rejection: unknown) => rejection);
      expect(error).toMatchObject({
        code: 'HOST_TIMEOUT',
        details: { method: 'ping', timeoutMs: SHORT_WAIT_MS },
      });
    } finally {
      await close(server);
    }
  });
});

describe('sendRpc response cap', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-client-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it(
    'refuses a response over 64 MiB from an older host with PROTOCOL_ERROR',
    { timeout: 30_000 },
    async () => {
      const socketFile = join(tempDir, 'rpc.sock');
      // An older host sends a success response of any size.
      const server = net.createServer((socket) => {
        socket.on('error', () => undefined);
        socket.once('data', () => {
          const piece = 'x'.repeat(1_048_576);
          for (let index = 0; index <= 64; index += 1) {
            socket.write(piece);
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketFile, () => {
          server.off('error', reject);
          resolve();
        });
      });

      try {
        const error = await sendRpc(socketFile, 'inspect', {}, 20_000).catch(
          (rejection: unknown) => rejection,
        );

        expect(error).toMatchObject({
          code: 'PROTOCOL_ERROR',
          retryable: false,
          message: 'RPC response is over the 67108864-character limit.',
          details: { method: 'inspect', maxResponseChars: 67_108_864 },
        });
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
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'sendRpc to a host that an older version started',
  () => {
    const uid = process.getuid?.() ?? 0;
    let socketFile = '';
    let oldSocketFile = '';

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'agent-tty-rpc-client-'));
      socketFile = socketPath(sessionDir(tempDir, 'session-01'));
      const legacy = legacySocketPath(socketFile);
      expect(legacy).not.toBeNull();
      oldSocketFile = legacy ?? '';
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      lstatHooks.entries.clear();
      lstatHooks.missing.clear();
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    });

    function oldPathShows(
      directory: { uid: number; mode: number },
      socket: { kind: 'socket' | 'symlink'; uid: number },
      root: { uid: number; mode: number } = { uid, mode: 0o755 },
    ): void {
      lstatHooks.entries.set(dirname(dirname(oldSocketFile)), {
        kind: 'directory',
        ...root,
      });
      lstatHooks.entries.set(dirname(oldSocketFile), {
        kind: 'directory',
        ...directory,
      });
      lstatHooks.entries.set(oldSocketFile, { ...socket, mode: 0o755 });
    }

    it('connects to the old path when the new socket is missing and the old one is ours', async () => {
      oldPathShows({ uid, mode: 0o700 }, { kind: 'socket', uid });

      await expect(
        sendRpc(socketFile, 'inspect', {}, 1_000),
      ).rejects.toMatchObject({
        code: 'HOST_UNREACHABLE',
        details: { socketPath: oldSocketFile, errno: 'ENOENT' },
      });
    });

    it('connects to the old path under an old root of root with the sticky bit', async () => {
      oldPathShows(
        { uid, mode: 0o700 },
        { kind: 'socket', uid },
        { uid: 0, mode: 0o1777 },
      );

      await expect(
        sendRpc(socketFile, 'inspect', {}, 1_000),
      ).rejects.toMatchObject({
        code: 'HOST_UNREACHABLE',
        details: { socketPath: oldSocketFile, errno: 'ENOENT' },
      });
    });

    it.each([
      ['another user', { uid: uid + 1, mode: 0o1777 }],
      ['this uid that others can write', { uid, mode: 0o777 }],
    ])(
      'does not connect to the old path under an old root of %s',
      async (_name, root) => {
        oldPathShows({ uid, mode: 0o700 }, { kind: 'socket', uid }, root);

        await expect(
          sendRpc(socketFile, 'inspect', {}, 1_000),
        ).rejects.toMatchObject({
          code: 'HOST_UNREACHABLE',
          details: { socketPath: socketFile, errno: 'ENOENT' },
        });
      },
    );

    it('does not connect when another user owns the new root', async () => {
      lstatHooks.entries.set(socketRootDirectory(), {
        kind: 'directory',
        uid: uid + 1,
        mode: 0o700,
      });
      const connect = vi.spyOn(net, 'connect');

      await expect(
        sendRpc(socketFile, 'inspect', {}, 1_000),
      ).rejects.toMatchObject({ code: 'STORAGE_WRITE_ERROR' });
      expect(connect).not.toHaveBeenCalled();
    });

    it('goes to the old path without a connect to the new one when another user owns the new root', async () => {
      lstatHooks.entries.set(socketRootDirectory(), {
        kind: 'directory',
        uid: uid + 1,
        mode: 0o700,
      });
      oldPathShows({ uid, mode: 0o700 }, { kind: 'socket', uid });
      const connect = vi.spyOn(net, 'connect');

      await expect(
        sendRpc(socketFile, 'inspect', {}, 1_000),
      ).rejects.toMatchObject({
        code: 'HOST_UNREACHABLE',
        details: { socketPath: oldSocketFile },
      });
      expect(connect.mock.calls).toEqual([[{ path: oldSocketFile }]]);
    });

    it('goes to the old path without a connect to the new one when the new root is missing', async () => {
      lstatHooks.missing.add(socketRootDirectory());
      oldPathShows({ uid, mode: 0o700 }, { kind: 'socket', uid });
      const connect = vi.spyOn(net, 'connect');

      await expect(
        sendRpc(socketFile, 'inspect', {}, 1_000),
      ).rejects.toMatchObject({
        code: 'HOST_UNREACHABLE',
        details: { socketPath: oldSocketFile },
      });
      expect(connect.mock.calls).toEqual([[{ path: oldSocketFile }]]);
    });

    it.each([
      [
        'a socket of another user',
        { uid, mode: 0o700 },
        { kind: 'socket', uid: uid + 1 },
      ],
      ['a symlink', { uid, mode: 0o700 }, { kind: 'symlink', uid }],
      [
        'a socket in a folder of another user',
        { uid: uid + 1, mode: 0o700 },
        { kind: 'socket', uid },
      ],
      [
        'a socket in a folder that others can write',
        { uid, mode: 0o777 },
        { kind: 'socket', uid },
      ],
    ] as const)(
      'does not connect to %s at the old path',
      async (_name, directory, socket) => {
        oldPathShows(directory, socket);

        await expect(
          sendRpc(socketFile, 'inspect', {}, 1_000),
        ).rejects.toMatchObject({
          code: 'HOST_UNREACHABLE',
          details: { socketPath: socketFile, errno: 'ENOENT' },
        });
      },
    );
  },
);
