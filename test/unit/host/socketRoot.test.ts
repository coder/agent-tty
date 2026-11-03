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

import { ensureSocketRoot } from '../../../src/host/lifecycle.js';

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
    await rm(parent, { recursive: true, force: true });
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
