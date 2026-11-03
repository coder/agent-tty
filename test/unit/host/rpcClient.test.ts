import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What lstat shows for a path, instead of the file system.
const lstatHooks = vi.hoisted(() => ({
  entries: new Map<
    string,
    { kind: 'directory' | 'socket' | 'symlink'; uid: number; mode: number }
  >(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const lstat = (async (path: string, ...rest: unknown[]) => {
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
      lstatHooks.entries.clear();
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    });

    function oldPathShows(
      directory: { uid: number; mode: number },
      socket: { kind: 'socket' | 'symlink'; uid: number },
    ): void {
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
