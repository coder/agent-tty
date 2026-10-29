import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupEvalHome,
  createIsolatedEvalHome,
} from '../../../../evals/lib/cliHarness.js';

describe('cleanupEvalHome', () => {
  let originalTmpdir: string | undefined;
  let fakeTempRoot: string;

  beforeEach(async () => {
    fakeTempRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-cleanup-eval-home-')),
    );
    originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = fakeTempRoot;
    // Guards the real temp folder: an unfixed cleanupEvalHome(tmpdir()) can only delete fakeTempRoot.
    expect(tmpdir()).toBe(fakeTempRoot);
  });

  afterEach(async () => {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    await rm(fakeTempRoot, { recursive: true, force: true });
  });

  it('refuses to delete the temp root itself', async () => {
    const sentinelPath = join(fakeTempRoot, 'sentinel.txt');
    await writeFile(sentinelPath, 'keep me\n');

    await expect(cleanupEvalHome(tmpdir())).rejects.toThrow(
      'home must be strictly inside the system temp directory',
    );
    expect(existsSync(sentinelPath)).toBe(true);
  });

  it('removes an isolated eval home inside the temp root', async () => {
    const home = await createIsolatedEvalHome();
    expect(dirname(home)).toBe(fakeTempRoot);

    await cleanupEvalHome(home);

    expect(existsSync(home)).toBe(false);
    expect(existsSync(fakeTempRoot)).toBe(true);
  });
});
