import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import type * as FsPromises from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  beforeRename: undefined as
    | ((from: string, to: string) => Promise<void>)
    | undefined,
  beforeLink: undefined as ((to: string) => Promise<void>) | undefined,
  beforeRm: undefined as ((path: string) => Promise<void>) | undefined,
  beforeWriteFile: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await fsHooks.beforeRename?.(String(args[0]), String(args[1]));
      return actual.rename(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await fsHooks.beforeLink?.(String(args[1]));
      return actual.link(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await fsHooks.beforeRm?.(String(args[0]));
      return actual.rm(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await fsHooks.beforeWriteFile?.(
        typeof args[0] === 'string' ? args[0] : '',
      );
      return actual.writeFile(...args);
    },
  };
});

import { captureHost } from '../../../src/host/hostRecord.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  appendArtifactWithRollback,
  createArtifactEntry,
  withArtifactManifestLock,
} from '../../../src/storage/artifactManifest.js';

const FAST = { waitMs: 100, unknownOwnerStaleMs: 60_000 };

function ownerRecord(pid: number, withProcess: boolean): string {
  return JSON.stringify({
    version: 1,
    token: `owner-${String(pid)}`,
    pid,
    process: withProcess ? captureHost(pid) : null,
  });
}

async function deadOwnerRecord(): Promise<string> {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const pid = child.pid;
  expect(pid).toBeGreaterThan(0);
  const record = captureHost(Number(pid));
  child.kill('SIGKILL');
  await once(child, 'exit');
  return JSON.stringify({
    version: 1,
    token: `dead-${String(pid)}`,
    pid,
    process: record,
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
    fsHooks.beforeRename = undefined;
    fsHooks.beforeLink = undefined;
    fsHooks.beforeRm = undefined;
    fsHooks.beforeWriteFile = undefined;
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

  it("lets one writer at a time in when many find a dead owner's lock", async () => {
    for (let round = 0; round < 10; round += 1) {
      await writeFile(lockPath, await deadOwnerRecord());
      let inside = 0;
      let maxInside = 0;
      const update = async (): Promise<void> => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(20);
        inside -= 1;
      };

      await Promise.all(
        Array.from({ length: 10 }, () =>
          withArtifactManifestLock(sessionDirectory, update, {
            waitMs: 5_000,
            unknownOwnerStaleMs: 60_000,
          }),
        ),
      );

      expect(maxInside).toBe(1);
    }
  }, 30_000);

  it('breaks a lock with an unknown owner whose time is far in the future', async () => {
    await writeFile(lockPath, 'not json');
    const inTwoMinutes = new Date(Date.now() + 120_000);
    await utimes(lockPath, inTwoMinutes, inTwoMinutes);

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('ran'),
        FAST,
      ),
    ).resolves.toBe('ran');
  });

  it.runIf(process.platform === 'linux')(
    'never judges an owner without a process record as dead',
    async () => {
      const contents = ownerRecord(deadPid(), false);
      await writeFile(lockPath, contents);

      await expect(
        withArtifactManifestLock(
          sessionDirectory,
          () => Promise.resolve(),
          FAST,
        ),
      ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_WRITE_ERROR });
      expect(await readFile(lockPath, 'utf8')).toBe(contents);
    },
  );

  it('removes old lock temp and break files when it takes the lock', async () => {
    const artifacts = join(sessionDirectory, 'artifacts');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    for (const name of [
      'manifest.json.lock.tmp-old',
      'manifest.json.lock.break',
    ]) {
      await writeFile(join(artifacts, name), 'left over');
      await utimes(join(artifacts, name), twoMinutesAgo, twoMinutesAgo);
    }
    await writeFile(join(artifacts, 'manifest.json.lock.tmp-new'), 'in use');

    await withArtifactManifestLock(sessionDirectory, () => Promise.resolve());

    expect(await readdir(artifacts)).toEqual(['manifest.json.lock.tmp-new']);
  });

  it('breaks a lock whose owner is gone', async () => {
    await writeFile(lockPath, await deadOwnerRecord());

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
    ['a lock file that does not parse', () => 'not json'],
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

  it('keeps a lock that changed after the dead owner was judged', async () => {
    await writeFile(lockPath, await deadOwnerRecord());
    const live = ownerRecord(process.pid, true);
    fsHooks.beforeLink = async (to) => {
      if (to === `${lockPath}.break`) {
        fsHooks.beforeLink = undefined;
        await writeFile(lockPath, live);
      }
    };
    const update = vi.fn(() => Promise.resolve());

    await expect(
      withArtifactManifestLock(sessionDirectory, update, FAST),
    ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_WRITE_ERROR });
    expect(update).not.toHaveBeenCalled();
    expect(await readFile(lockPath, 'utf8')).toBe(live);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([
      'manifest.json.lock',
    ]);
  });

  it('takes the lock on a filesystem without hard links', async () => {
    fsHooks.beforeLink = () =>
      Promise.reject(Object.assign(new Error('no links'), { code: 'EPERM' }));

    await expect(
      withArtifactManifestLock(sessionDirectory, async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
          pid: number;
        };
        return owner.pid;
      }),
    ).resolves.toBe(process.pid);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('dates the lock from when it was taken, not from when the wait began', async () => {
    await writeFile(lockPath, ownerRecord(process.pid, true));
    const waitStartedAt = Date.now();
    const pending = withArtifactManifestLock(
      sessionDirectory,
      async () => (await stat(lockPath)).mtimeMs,
      { waitMs: 5_000, unknownOwnerStaleMs: 60_000 },
    );
    await sleep(1_200);
    await rm(lockPath);

    expect(await pending).toBeGreaterThanOrEqual(waitStartedAt + 1_000);
  });

  it('breaks its own lock on the next update when the release failed', async () => {
    let failures = 0;
    fsHooks.beforeRm = (path) => {
      if (path !== lockPath) {
        return Promise.resolve();
      }
      failures += 1;
      return Promise.reject(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
    };

    await expect(
      withArtifactManifestLock(sessionDirectory, () =>
        Promise.resolve('first'),
      ),
    ).resolves.toBe('first');
    expect(failures).toBe(3);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([
      'manifest.json.lock',
    ]);

    fsHooks.beforeRm = undefined;
    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('second'),
        FAST,
      ),
    ).resolves.toBe('second');
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('leaves a lock that another owner took over in the meantime', async () => {
    const other = ownerRecord(process.pid, true);

    await withArtifactManifestLock(sessionDirectory, async () => {
      await writeFile(lockPath, other);
    });

    expect(await readFile(lockPath, 'utf8')).toBe(other);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([
      'manifest.json.lock',
    ]);
  });

  it('times out on schedule when the lock keeps changing hands', async () => {
    fsHooks.beforeLink = () =>
      Promise.reject(Object.assign(new Error('taken'), { code: 'EEXIST' }));

    await expect(
      withArtifactManifestLock(sessionDirectory, () => Promise.resolve(), FAST),
    ).rejects.toMatchObject({
      code: ERROR_CODES.STORAGE_WRITE_ERROR,
      retryable: true,
    });
  });

  it('keeps a rollback file that the manifest already lists when it cannot take the lock', async () => {
    const artifact = join(sessionDirectory, 'artifacts', 'recording-1.cast');
    await writeFile(artifact, 'cast');
    const entry = () =>
      createArtifactEntry({
        kind: 'recording',
        filename: 'recording-1.cast',
        sessionId: 'session-01',
        capturedAtSeq: 1,
        metadata: {},
      });
    await appendArtifactWithRollback({
      sessionDir: sessionDirectory,
      entry: entry(),
      rollbackArtifactPath: artifact,
    });
    fsHooks.beforeWriteFile = (path) =>
      path.includes('manifest.json.lock.tmp-')
        ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' }))
        : Promise.resolve();

    await expect(
      appendArtifactWithRollback({
        sessionDir: sessionDirectory,
        entry: entry(),
        rollbackArtifactPath: artifact,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_WRITE_ERROR });
    expect(await readFile(artifact, 'utf8')).toBe('cast');
  });

  it('judges a FIFO at the lock path as an unknown owner instead of blocking on it', async () => {
    expect(spawnSync('mkfifo', [lockPath]).status).toBe(0);
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
  });

  it('removes the rollback file and reports STORAGE_WRITE_ERROR when it cannot take the lock', async () => {
    const artifact = join(sessionDirectory, 'artifacts', 'recording-1.cast');
    await writeFile(artifact, 'cast');
    fsHooks.beforeWriteFile = (path) =>
      path.includes('manifest.json.lock.tmp-')
        ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' }))
        : Promise.resolve();

    await expect(
      appendArtifactWithRollback({
        sessionDir: sessionDirectory,
        entry: createArtifactEntry({
          kind: 'recording',
          filename: 'recording-1.cast',
          sessionId: 'session-01',
          capturedAtSeq: 1,
          metadata: {},
        }),
        rollbackArtifactPath: artifact,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_WRITE_ERROR });
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('reports SESSION_NOT_FOUND when the session folder is gone', async () => {
    await rm(sessionDirectory, { recursive: true });

    await expect(
      withArtifactManifestLock(sessionDirectory, () => Promise.resolve()),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_FOUND });
  });
});
