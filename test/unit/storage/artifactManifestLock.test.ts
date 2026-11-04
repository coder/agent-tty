import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
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
  beforeUtimes: undefined as ((path: string) => Promise<void>) | undefined,
  beforeReaddir: undefined as ((path: string) => Promise<void>) | undefined,
  beforeLstat: undefined as ((path: string) => Promise<void>) | undefined,
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
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      await fsHooks.beforeLstat?.(String(args[0]));
      return actual.lstat(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await fsHooks.beforeReaddir?.(String(args[0]));
      return actual.readdir(...args);
    },
    utimes: async (...args: Parameters<typeof actual.utimes>) => {
      await fsHooks.beforeUtimes?.(String(args[0]));
      return actual.utimes(...args);
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

// The lock reads time only through Date. A frozen Date keeps the wait
// deadline from passing, so a call that must take the lock cannot lose a race
// with a slow runner, and only the lock's age or owner can let it in.
function freezeLockClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
}

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
    fsHooks.beforeUtimes = undefined;
    fsHooks.beforeReaddir = undefined;
    fsHooks.beforeLstat = undefined;
    vi.useRealTimers();
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
    freezeLockClock();

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

  it('removes lock temp and break files whose owner is gone once it had to wait for the lock', async () => {
    const artifacts = join(sessionDirectory, 'artifacts');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    for (const name of [
      'manifest.json.lock.tmp-old',
      'manifest.json.lock.break',
    ]) {
      await writeFile(join(artifacts, name), 'left over');
      await utimes(join(artifacts, name), twoMinutesAgo, twoMinutesAgo);
    }
    await writeFile(
      join(artifacts, 'manifest.json.lock.tmp-dead'),
      await deadOwnerRecord(),
    );
    await writeFile(join(artifacts, 'manifest.json.lock.tmp-new'), 'in use');
    await writeFile(lockPath, await deadOwnerRecord());
    freezeLockClock();

    await withArtifactManifestLock(sessionDirectory, () => Promise.resolve());

    expect(await readdir(artifacts)).toEqual(['manifest.json.lock.tmp-new']);
  });

  it('does not read the artifacts folder for leftovers when it finds the lock free', async () => {
    const artifacts = join(sessionDirectory, 'artifacts');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await writeFile(join(artifacts, 'manifest.json.lock.tmp-old'), 'left over');
    await utimes(
      join(artifacts, 'manifest.json.lock.tmp-old'),
      twoMinutesAgo,
      twoMinutesAgo,
    );

    await withArtifactManifestLock(sessionDirectory, () => Promise.resolve());

    expect(await readdir(artifacts)).toEqual(['manifest.json.lock.tmp-old']);
  });

  it('removes the break file of a breaker that died and breaks the lock at once', async () => {
    await writeFile(lockPath, await deadOwnerRecord());
    await writeFile(`${lockPath}.break`, await deadOwnerRecord());
    freezeLockClock();

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('ran'),
        FAST,
      ),
    ).resolves.toBe('ran');
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('keeps the break file of a live breaker until it is older than unknownOwnerStaleMs', async () => {
    const breakPath = `${lockPath}.break`;
    await writeFile(lockPath, await deadOwnerRecord());
    await writeFile(breakPath, ownerRecord(process.pid, true));

    await expect(
      withArtifactManifestLock(sessionDirectory, () => Promise.resolve(), FAST),
    ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_WRITE_ERROR });
    expect(await readFile(breakPath, 'utf8')).toBe(
      ownerRecord(process.pid, true),
    );

    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await utimes(breakPath, twoMinutesAgo, twoMinutesAgo);
    freezeLockClock();
    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('ran'),
        FAST,
      ),
    ).resolves.toBe('ran');
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it("lets one breaker act at a time when one stops while it removes a dead breaker's break file", async () => {
    // The trace: W2 judges a dead breaker's break file and stops before its
    // rm. W1 then takes a new break file, reads the dead owner's lock and
    // stops before its rm. W2 resumes, removes W1's break file by path,
    // breaks the lock and enters. W1 resumes and removes W2's fresh lock.
    await writeFile(lockPath, await deadOwnerRecord());
    await writeFile(`${lockPath}.break`, await deadOwnerRecord());
    const writer = new AsyncLocalStorage<string>();
    const deferred = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve = (): void => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const w2AtBreakRm = deferred();
    const resumeW2 = deferred();
    const w1AtLockRm = deferred();
    const resumeW1 = deferred();
    const firstInside = deferred();
    const secondInside = deferred();
    const leave = deferred();
    let w2Paused = false;
    let w2Resumed = false;
    let w1Paused = false;
    fsHooks.beforeRm = async (path) => {
      const who = writer.getStore();
      if (who === 'W2' && path === `${lockPath}.break` && !w2Paused) {
        w2Paused = true;
        w2AtBreakRm.resolve();
        await resumeW2.promise;
      }
      if (who === 'W1' && path === lockPath && !w2Resumed && !w1Paused) {
        w1Paused = true;
        w1AtLockRm.resolve();
        await resumeW1.promise;
      }
    };
    let inside = 0;
    let maxInside = 0;
    const update = async (): Promise<void> => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      (inside === 1 ? firstInside : secondInside).resolve();
      await leave.promise;
      inside -= 1;
    };
    const contend = (who: string): Promise<void> =>
      writer.run(who, () =>
        withArtifactManifestLock(sessionDirectory, update, {
          waitMs: 10_000,
          unknownOwnerStaleMs: 60_000,
        }),
      );

    const w2 = contend('W2');
    await w2AtBreakRm.promise;
    const w1 = contend('W1');
    await Promise.race([w1AtLockRm.promise, sleep(300)]);
    w2Resumed = true;
    resumeW2.resolve();
    await firstInside.promise;
    resumeW1.resolve();
    await Promise.race([secondInside.promise, sleep(300)]);
    leave.resolve();
    await Promise.all([w1, w2]);

    expect(maxInside).toBe(1);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('lists only the announcements while it announces itself, not the artifacts folder', async () => {
    // A listing of a large artifacts folder while the announcement exists
    // made breakers that started together keep seeing each other.
    const artifacts = join(sessionDirectory, 'artifacts');
    await writeFile(lockPath, await deadOwnerRecord());
    const announced = (): boolean => {
      const inFolder = (path: string): string[] => {
        try {
          return readdirSync(path);
        } catch {
          return [];
        }
      };
      return (
        inFolder(`${lockPath}.breakers`).length > 0 ||
        inFolder(artifacts).some((name) =>
          name.startsWith('manifest.json.lock.breaker'),
        )
      );
    };
    const listedWhileAnnounced: string[] = [];
    fsHooks.beforeReaddir = (path) => {
      if (announced()) {
        listedWhileAnnounced.push(path);
      }
      return Promise.resolve();
    };

    await withArtifactManifestLock(sessionDirectory, () => Promise.resolve());
    fsHooks.beforeReaddir = undefined;

    expect(listedWhileAnnounced).not.toHaveLength(0);
    expect(listedWhileAnnounced).not.toContain(artifacts);
    expect(await readdir(artifacts)).toEqual([]);
  });

  it("removes a dead breaker's fresh break file once it had to wait for a live lock", async () => {
    await writeFile(lockPath, ownerRecord(process.pid, true));
    await writeFile(`${lockPath}.break`, await deadOwnerRecord());
    freezeLockClock();
    let refreshes = 0;
    fsHooks.beforeUtimes = async (path) => {
      if (path.startsWith(`${lockPath}.tmp-`) && (refreshes += 1) === 2) {
        await rm(lockPath);
      }
    };

    await withArtifactManifestLock(sessionDirectory, () => Promise.resolve());

    expect(refreshes).toBe(2);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('takes a lock that was let go while it was stopped past its deadline', async () => {
    // A writer stopped (SIGSTOP) while it judges the lock resumes after its
    // deadline. The owner let go in the meantime, so the lock is free.
    await writeFile(lockPath, ownerRecord(process.pid, true));
    freezeLockClock();
    fsHooks.beforeLstat = async (path) => {
      if (path === lockPath) {
        fsHooks.beforeLstat = undefined;
        vi.setSystemTime(Date.now() + 60_000);
        await rm(lockPath);
      }
    };

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('ran'),
        FAST,
      ),
    ).resolves.toBe('ran');
  });

  it('announces itself again when another breaker removed the empty folder before its link', async () => {
    const folder = `${lockPath}.breakers`;
    await writeFile(lockPath, await deadOwnerRecord());
    freezeLockClock();
    let removed = false;
    fsHooks.beforeLink = async (to) => {
      if (to.startsWith(`${folder}/`) && !removed) {
        removed = true;
        await rmdir(folder);
      }
    };

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('ran'),
        FAST,
      ),
    ).resolves.toBe('ran');
    expect(removed).toBe(true);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  // APFS answers EINVAL, not ENOENT, to a link into a folder that another
  // process removes during the call (macOS CI run 41762561666).
  it('announces itself again when the link into a folder another breaker removes fails with EINVAL', async () => {
    const folder = `${lockPath}.breakers`;
    await writeFile(lockPath, await deadOwnerRecord());
    freezeLockClock();
    let removed = false;
    fsHooks.beforeLink = async (to) => {
      if (to.startsWith(`${folder}/`) && !removed) {
        removed = true;
        await rmdir(folder);
        throw Object.assign(new Error(`EINVAL: invalid argument, link`), {
          code: 'EINVAL',
        });
      }
    };

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        () => Promise.resolve('ran'),
        FAST,
      ),
    ).resolves.toBe('ran');
    expect(removed).toBe(true);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('waits longer each time it meets another breaker', async () => {
    // A live breaker's announcement that stays: every attempt meets it.
    const folder = `${lockPath}.breakers`;
    await writeFile(lockPath, await deadOwnerRecord());
    await mkdir(folder);
    await writeFile(join(folder, 'live'), ownerRecord(process.pid, true));
    let listings = 0;
    fsHooks.beforeReaddir = (path) => {
      if (path === folder) {
        listings += 1;
      }
      return Promise.resolve();
    };

    await expect(
      withArtifactManifestLock(sessionDirectory, () => Promise.resolve(), {
        waitMs: 1_500,
        unknownOwnerStaleMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STORAGE_WRITE_ERROR });
    // A backoff from 5 ms that doubles up to 200 ms allows about 12
    // attempts in 1.5 s. A backoff that stays at 5 ms allows over 100.
    expect(listings).toBeGreaterThan(3);
    expect(listings).toBeLessThan(40);
  });

  it("removes a dead breaker's announcement and breaks the lock at once", async () => {
    const folder = `${lockPath}.breakers`;
    await writeFile(lockPath, await deadOwnerRecord());
    await mkdir(folder);
    await writeFile(join(folder, 'dead'), await deadOwnerRecord());

    await expect(
      withArtifactManifestLock(sessionDirectory, () => Promise.resolve('ran'), {
        waitMs: 2_000,
        unknownOwnerStaleMs: 60_000,
      }),
    ).resolves.toBe('ran');
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it("sweeps a dead breaker's announcement once it had to wait for a live lock", async () => {
    // The lock is live, so this writer never breaks and never lists the
    // announcements. Only the sweep can remove the dead one.
    const folder = `${lockPath}.breakers`;
    await writeFile(lockPath, ownerRecord(process.pid, true));
    await mkdir(folder);
    await writeFile(join(folder, 'dead'), await deadOwnerRecord());
    freezeLockClock();
    let refreshes = 0;
    fsHooks.beforeUtimes = async (path) => {
      if (path.startsWith(`${lockPath}.tmp-`) && (refreshes += 1) === 2) {
        await rm(lockPath);
      }
    };

    await withArtifactManifestLock(sessionDirectory, () => Promise.resolve());

    expect(refreshes).toBe(2);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('writes its temp file again when another writer removed it during the wait', async () => {
    await writeFile(lockPath, ownerRecord(process.pid, true));
    freezeLockClock();
    let refreshes = 0;
    // On the second attempt, a writer that took the lock while this one was
    // stopped has removed this one's temp file and let go of the lock.
    fsHooks.beforeUtimes = async (path) => {
      if (!path.startsWith(`${lockPath}.tmp-`)) {
        return;
      }
      refreshes += 1;
      if (refreshes === 2) {
        await rm(path);
        await rm(lockPath);
      }
    };

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        async () => {
          const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
            pid: number;
          };
          return owner.pid;
        },
        FAST,
      ),
    ).resolves.toBe(process.pid);
    expect(refreshes).toBe(2);
    expect(await readdir(join(sessionDirectory, 'artifacts'))).toEqual([]);
  });

  it('breaks a lock whose owner is gone', async () => {
    await writeFile(lockPath, await deadOwnerRecord());
    freezeLockClock();

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
      freezeLockClock();
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
    freezeLockClock();
    const waitStartedAt = Date.now();
    let attempts = 0;
    // The first attempt finds the lock held, and the clock moves on. The
    // owner lets go just before the second attempt links.
    fsHooks.beforeLink = async (to) => {
      if (to !== lockPath) {
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        vi.setSystemTime(waitStartedAt + 1_200);
      } else if (attempts === 2) {
        await rm(lockPath);
      }
    };

    await expect(
      withArtifactManifestLock(
        sessionDirectory,
        async () => (await stat(lockPath)).mtimeMs,
        { waitMs: 5_000, unknownOwnerStaleMs: 60_000 },
      ),
    ).resolves.toBeGreaterThanOrEqual(waitStartedAt + 1_000);
    expect(attempts).toBe(2);
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
    freezeLockClock();
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
    freezeLockClock();
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
