import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureHome, resolveHome } from '../../../src/storage/home.js';

let root = '';

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveHome', () => {
  it('gives a Home behind a symlink the same path before and after it exists', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'));
    const configured = join(root, 'link', 'nested', 'home');

    const before = resolveHome(configured);
    const created = await ensureHome(configured);

    expect(before).toBe(join(root, 'real', 'nested', 'home'));
    expect(created).toBe(before);
    expect(resolveHome(configured)).toBe(before);
  });
});
