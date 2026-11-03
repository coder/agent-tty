import { lstatSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  beforeChmod: undefined as ((path: string) => void) | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const chmod = async (
    ...args: Parameters<typeof actual.chmod>
  ): Promise<void> => {
    if (typeof args[0] === 'string') {
      fsHooks.beforeChmod?.(args[0]);
    }
    await actual.chmod(...args);
  };
  return { ...actual, chmod };
});

import type * as FsPromises from 'node:fs/promises';

import {
  ensureSocketRoot,
  socketRootExists,
} from '../../../src/host/socketRoot.js';

let parent = '';
let root = '';

describe.skipIf(process.platform === 'win32')('ensureSocketRoot', () => {
  beforeEach(async () => {
    parent = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-socket-root-')),
    );
    root = join(parent, 'root');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    fsHooks.beforeChmod = undefined;
    await rm(parent, { recursive: true, force: true });
  });

  it('creates the root without group or other bits, also under umask 0', async () => {
    const modes: number[] = [];
    fsHooks.beforeChmod = (path) => {
      if (path === root) {
        modes.push(lstatSync(path).mode & 0o777);
      }
    };
    const umask = process.umask(0);
    try {
      await ensureSocketRoot(root);
    } finally {
      process.umask(umask);
    }

    expect(modes).toEqual([0o700]);
  });

  it('creates a missing root that only its owner can use, and accepts it again', async () => {
    await ensureSocketRoot(root);
    await ensureSocketRoot(root);

    const stats = await lstat(root);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.uid).toBe(process.getuid?.());
    expect(stats.mode & 0o077).toBe(0);
  });

  it.each([
    [
      'a directory that other users can read',
      async () => {
        await mkdir(root);
        await chmod(root, 0o755);
      },
    ],
    [
      'a symlink to a private directory',
      async () => {
        await mkdir(`${root}-target`, { mode: 0o700 });
        await symlink(`${root}-target`, root);
      },
    ],
    [
      'a file',
      async () => {
        await writeFile(root, '', { mode: 0o600 });
      },
    ],
  ])('refuses %s', async (_name, prepare) => {
    await prepare();

    await expect(ensureSocketRoot(root)).rejects.toMatchObject({
      code: 'STORAGE_WRITE_ERROR',
      message: expect.stringContaining(root) as string,
      details: { path: root, ownerUid: process.getuid?.() },
    });
  });

  // A concurrent create whose umask took owner bits shows mode 000 until its
  // chmod.
  it.each(['0', '500', '600'])(
    'gives the owner bits back to a directory of this uid with mode %s',
    async (mode) => {
      await mkdir(root, { mode: 0o700 });
      await chmod(root, Number.parseInt(mode, 8));

      try {
        await ensureSocketRoot(root);
        expect((await lstat(root)).mode & 0o777).toBe(0o700);
      } finally {
        await chmod(root, 0o700);
      }
    },
  );

  it('reads a missing root as missing and a private root as there', async () => {
    expect(await socketRootExists(root)).toBe(false);
    await ensureSocketRoot(root);
    expect(await socketRootExists(root)).toBe(true);
  });

  it('gives the owner bits back to a private root that it reads as there', async () => {
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0);

    try {
      expect(await socketRootExists(root)).toBe(true);
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
    } finally {
      await chmod(root, 0o700);
    }
  });

  it('refuses an existing root that is not private', async () => {
    await mkdir(root);
    await chmod(root, 0o755);

    await expect(socketRootExists(root)).rejects.toMatchObject({
      code: 'STORAGE_WRITE_ERROR',
      details: { path: root, mode: '755' },
    });
    await chmod(root, 0o700);
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await expect(socketRootExists(root)).rejects.toMatchObject({
      code: 'STORAGE_WRITE_ERROR',
      details: { path: root, ownerUid: uid },
    });
  });

  it('refuses a directory of another user', async () => {
    await mkdir(root, { mode: 0o700 });
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);

    await expect(ensureSocketRoot(root)).rejects.toMatchObject({
      code: 'STORAGE_WRITE_ERROR',
      message: expect.stringContaining(`uid ${String(uid)}`) as string,
      details: { path: root, ownerUid: uid },
    });
  });
});
