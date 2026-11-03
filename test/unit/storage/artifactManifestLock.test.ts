import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureHost } from '../../../src/host/hostRecord.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import { withArtifactManifestLock } from '../../../src/storage/artifactManifest.js';

const FAST = { waitMs: 100, unknownOwnerStaleMs: 60_000 };

function ownerRecord(pid: number, withProcess: boolean): string {
  return JSON.stringify({
    version: 1,
    token: `owner-${String(pid)}`,
    pid,
    process: withProcess ? captureHost(pid) : null,
  });
}

function deadPid(): number {
  const child = spawnSync('/bin/sh', ['-c', 'exit 0']);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid;
}

describe('artifact manifest lock', () => {
  let home = '';
  let sessionDirectory = '';
  let lockPath = '';

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-lock-')));
    sessionDirectory = join(home, 'session-01');
    await mkdir(join(sessionDirectory, 'artifacts'), { recursive: true });
    lockPath = join(sessionDirectory, 'artifacts', 'manifest.json.lock');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('holds the lock during the update and removes it afterwards', async () => {
    const seen = await withArtifactManifestLock(sessionDirectory, async () => {
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
        pid: number;
      };
      return owner.pid;
    });

    expect(seen).toBe(process.pid);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('waits for a live owner and runs the update once it lets go', async () => {
    await writeFile(lockPath, ownerRecord(process.pid, true));
    const update = vi.fn(() => Promise.resolve('done'));

    const pending = withArtifactManifestLock(sessionDirectory, update, {
      waitMs: 5_000,
      unknownOwnerStaleMs: 60_000,
    });
    await sleep(150);
    expect(update).not.toHaveBeenCalled();
    await rm(lockPath);

    await expect(pending).resolves.toBe('done');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('times out on a live owner with a retryable STORAGE_WRITE_ERROR and keeps its lock', async () => {
    const contents = ownerRecord(process.pid, true);
    await writeFile(lockPath, contents);
    const update = vi.fn(() => Promise.resolve());

    await expect(
      withArtifactManifestLock(sessionDirectory, update, FAST),
    ).rejects.toMatchObject({
      code: ERROR_CODES.STORAGE_WRITE_ERROR,
      retryable: true,
      details: { lockPath, holderPid: process.pid },
    });
    expect(update).not.toHaveBeenCalled();
    expect(await readFile(lockPath, 'utf8')).toBe(contents);
  });

  it('breaks a lock whose owner is gone', async () => {
    await writeFile(lockPath, ownerRecord(deadPid(), false));

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('ran'),
        FAST,
      ),
    ).resolves.toBe('ran');
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it.each([
    ['an owner it cannot judge', () => ownerRecord(process.pid, false)],
    ['an unreadable lock file', () => 'not json'],
  ])(
    'breaks a lock with %s only once the lock is older than unknownOwnerStaleMs',
    async (_label, contents) => {
      await writeFile(lockPath, contents());
      const update = vi.fn(() => Promise.resolve('ran'));

      await expect(
        withArtifactManifestLock(sessionDirectory, update, FAST),
      ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_WRITE_ERROR });
      expect(update).not.toHaveBeenCalled();

      const twoMinutesAgo = new Date(Date.now() - 120_000);
      await utimes(lockPath, twoMinutesAgo, twoMinutesAgo);
      await expect(
        withArtifactManifestLock(sessionDirectory, update, FAST),
      ).resolves.toBe('ran');
      expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
    },
  );

  it('leaves a lock that another owner took over in the meantime', async () => {
    const other = ownerRecord(process.pid, true);

    await withArtifactManifestLock(sessionDirectory, async () => {
      await writeFile(lockPath, other);
    });

    expect(await readFile(lockPath, 'utf8')).toBe(other);
  });

  it('reports SESSION_NOT_FOUND when the session folder is gone', async () => {
    await rm(sessionDirectory, { recursive: true });

    await expect(
      withArtifactManifestLock(sessionDirectory, () => Promise.resolve()),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_FOUND });
  });
});
