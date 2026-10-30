import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  afterReadFile: undefined as ((path: string) => Promise<void>) | undefined,
  // /proc/<pid>/stat by pid, or the error that its read throws.
  proc: undefined as Map<string, string | Error> | undefined,
  mountinfo: undefined as string | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs');
  const readdirSync = ((path: string, ...rest: unknown[]) =>
    fsHooks.proc !== undefined && path === '/proc'
      ? ['self', ...fsHooks.proc.keys()]
      : (actual.readdirSync as (...args: unknown[]) => unknown)(
          path,
          ...rest,
        )) as typeof actual.readdirSync;
  const readFileSync = ((path: string, ...rest: unknown[]) => {
    if (fsHooks.proc !== undefined && path === '/proc/self/mountinfo') {
      if (fsHooks.mountinfo === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return fsHooks.mountinfo;
    }
    const pid = /^\/proc\/(\d+)\/stat$/.exec(path)?.[1];
    if (fsHooks.proc === undefined || pid === undefined) {
      return (actual.readFileSync as (...args: unknown[]) => unknown)(
        path,
        ...rest,
      );
    }
    const stat = fsHooks.proc.get(pid);
    if (stat instanceof Error) {
      throw stat;
    }
    return stat;
  }) as typeof actual.readFileSync;
  return { ...actual, readdirSync, readFileSync };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const readFile = async (
    ...args: Parameters<typeof actual.readFile>
  ): Promise<string | Buffer> => {
    const contents = await actual.readFile(...args);
    if (typeof args[0] === 'string') {
      await fsHooks.afterReadFile?.(args[0]);
    }
    return contents;
  };
  return { ...actual, readFile };
});

// destroy and reconcile poll for about 5 s. These tests skip the waits.
vi.mock('node:timers/promises', async () => {
  const actual = await vi.importActual<typeof TimersPromises>(
    'node:timers/promises',
  );
  return {
    ...actual,
    setTimeout: (_delay: number, value?: unknown, options?: object) =>
      actual.setImmediate(value, options),
  };
});

import type * as Fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type * as TimersPromises from 'node:timers/promises';

import {
  allocateSession,
  destroySession,
  cliRunsInsideProgramSession,
  isProcessGroupAlive,
  killProcessGroupBestEffort,
  reconcileSession,
  type AllocateConfig,
} from '../../../src/host/lifecycle.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';
import { readManifest, writeManifest } from '../../../src/storage/manifests.js';
import { manifestPath, sessionDir } from '../../../src/storage/sessionPaths.js';

const HOST_PID = 2_147_483_646;
const CHILD_PID = 2_147_483_645;

let home = '';

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-lifecycle-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fsHooks.afterReadFile = undefined;
  fsHooks.proc = undefined;
  fsHooks.mountinfo = undefined;
  await rm(home, { recursive: true, force: true });
});

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function procMount(options: string): string {
  return `22 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc ${options}\n`;
}

// /proc shows one process of the program's group per state, under a command
// name with spaces and parentheses, beside a process of another group and a
// process that ends during the scan. Unless the test set its own, /proc is
// mounted without hidepid, so the result does not depend on the host.
function procShowsGroup(...states: string[]): void {
  fsHooks.mountinfo ??= procMount('rw');
  fsHooks.proc = new Map<string, string | Error>([
    ['1', '1 (init) S 0 1 1 0 -1'],
    ['2', errno('ESRCH')],
  ]);
  states.forEach((state, index) => {
    const pid = String(100 + index);
    fsHooks.proc?.set(
      pid,
      `${pid} (a) b (c) ${state} 1 ${String(CHILD_PID)} ${String(CHILD_PID)} 0 -1`,
    );
  });
}

function gcRemovesFolderAfterRead(directory: string, nth: number): void {
  let reads = 0;
  fsHooks.afterReadFile = async (path) => {
    if (path === manifestPath(directory)) {
      reads += 1;
      if (reads === nth) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

async function seedSession(record: SessionRecord): Promise<string> {
  const directory = sessionDir(home, record.sessionId);
  await mkdir(directory, { recursive: true });
  await writeManifest(manifestPath(directory), record);
  return directory;
}

function killProbeReportsDead(
  beforeHostReportsDead: () => void = () => undefined,
) {
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === HOST_PID && signal === 0) {
      beforeHostReportsDead();
    }
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-10-29T12:00:00.000Z',
    updatedAt: '2026-10-29T12:00:00.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: HOST_PID,
    childPid: CHILD_PID,
    exitCode: null,
    exitSignal: null,
    ...overrides,
  };
}

describe('allocateSession', () => {
  function makeConfig(overrides: Partial<AllocateConfig> = {}): AllocateConfig {
    return {
      home,
      command: ['/bin/sh', '-c', 'true'],
      shellPath: '/bin/sh',
      cwd: home,
      cols: 80,
      rows: 24,
      env: {},
      term: 'xterm-256color',
      ...overrides,
    };
  }

  it('launches the host before the manifest exists and writes the manifest with its pid', async () => {
    const launches: { sessionId: string; manifestExisted: boolean }[] = [];

    const result = await allocateSession(makeConfig(), (sessionId) => {
      launches.push({
        sessionId,
        manifestExisted: existsSync(manifestPath(sessionDir(home, sessionId))),
      });
      return 4242;
    });

    expect(launches).toEqual([
      { sessionId: result.sessionId, manifestExisted: false },
    ]);
    expect(
      await readManifest(manifestPath(result.sessionDirectory)),
    ).toMatchObject({
      sessionId: result.sessionId,
      status: 'running',
      hostPid: 4242,
      childPid: null,
    });
  });

  it('does not launch a host when the working directory does not exist', async () => {
    const launch = vi.fn(() => 4242);

    await expect(
      allocateSession(makeConfig({ cwd: join(home, 'missing') }), launch),
    ).rejects.toMatchObject({ code: 'STORAGE_READ_ERROR' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not launch a host when the shell does not exist', async () => {
    const launch = vi.fn(() => 4242);

    await expect(
      allocateSession(
        makeConfig({ shellPath: join(home, 'missing-shell') }),
        launch,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('reconcileSession', () => {
  it('keeps an exit that the host records after the read and before the liveness check', async () => {
    const directory = await seedSession(makeRecord());
    const exited = makeRecord({ status: 'exited', exitCode: 0 });
    killProbeReportsDead(() => {
      writeFileSync(manifestPath(directory), JSON.stringify(exited));
    });

    await reconcileSession(directory);

    expect(await readManifest(manifestPath(directory))).toEqual(exited);
  });

  it('marks a running session failed when its host died without recording an exit', async () => {
    const directory = await seedSession(makeRecord());
    killProbeReportsDead();

    await reconcileSession(directory);

    expect(await readManifest(manifestPath(directory))).toMatchObject({
      status: 'failed',
      failureOrigin: 'host-death',
      exitCode: null,
      hostPid: null,
      childPid: null,
    });
  });

  it('writes nothing while the program group survives its kill', async () => {
    const record = makeRecord();
    const directory = await seedSession(record);
    procShowsGroup('S');
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === HOST_PID) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      return true;
    });

    await reconcileSession(directory);

    expect(await readManifest(manifestPath(directory))).toEqual(record);
  });

  it('keeps a destroyed record that a destroy writes while reconcile waits for the group', async () => {
    const directory = await seedSession(makeRecord());
    const destroyed = makeRecord({
      status: 'destroyed',
      hostPid: null,
      childPid: null,
    });
    procShowsGroup('S');
    let probes = 0;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -CHILD_PID && signal === 0 && probes++ === 0) {
        writeFileSync(manifestPath(directory), JSON.stringify(destroyed));
        return true;
      }
      throw errno('ESRCH');
    });

    await reconcileSession(directory);

    expect(probes).toBe(2);
    expect(await readManifest(manifestPath(directory))).toEqual(destroyed);
  });

  it('leaves a folder that gc removed after the re-read removed', async () => {
    const directory = await seedSession(makeRecord());
    killProbeReportsDead();
    gcRemovesFolderAfterRead(directory, 2);

    await reconcileSession(directory);

    expect(existsSync(directory)).toBe(false);
  });
});

describe('destroySession', () => {
  it('fails with SESSION_NOT_FOUND and leaves the folder removed when gc removes it before the destroyed write', async () => {
    vi.stubEnv('AGENT_TTY_HOME', home);
    const directory = await seedSession(makeRecord());
    killProbeReportsDead();
    gcRemovesFolderAfterRead(directory, 2);

    await expect(destroySession('session-01', true)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });

    expect(existsSync(directory)).toBe(false);
  });
});

function killFailsWith(code: string) {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  });
}

describe('cliRunsInsideProgramSession', () => {
  const platform = process.platform;

  function ownId(field: 'sid' | 'pgid'): number {
    return Number(
      execFileSync('ps', ['-o', `${field}=`, '-p', String(process.pid)], {
        encoding: 'utf8',
      }),
    );
  }

  async function expectMatchesOnly(id: number): Promise<void> {
    expect(process.pid).not.toBe(id);
    const directory = await seedSession(makeRecord({ childPid: id }));
    expect(await cliRunsInsideProgramSession('session-01')).toBe(true);

    await writeManifest(
      manifestPath(directory),
      makeRecord({ childPid: process.pid }),
    );
    expect(await cliRunsInsideProgramSession('session-01')).toBe(false);
  }

  beforeEach(() => {
    vi.stubEnv('AGENT_TTY_HOME', home);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  // Only Linux has /proc/self/stat.
  it.runIf(platform === 'linux')(
    "on linux matches the caller's session only",
    async () => {
      await expectMatchesOnly(ownId('sid'));
    },
  );

  it("on darwin matches the caller's process group only", async () => {
    const pgid = ownId('pgid');
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    await expectMatchesOnly(pgid);
  });

  it("on darwin matches the caller's process group with no ps on PATH", async () => {
    const pgid = ownId('pgid');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.stubEnv('PATH', '');

    await expectMatchesOnly(pgid);
  });

  it('matches a caller whose environment names the session before a manifest names the program', async () => {
    await seedSession(makeRecord({ childPid: null }));
    vi.stubEnv('AGENT_TTY_SESSION_ID', 'session-01');
    expect(await cliRunsInsideProgramSession('session-01')).toBe(true);

    vi.stubEnv('AGENT_TTY_SESSION_ID', 'session-02');
    expect(await cliRunsInsideProgramSession('session-01')).toBe(false);
  });

  it('on win32 never matches', async () => {
    await seedSession(makeRecord({ childPid: ownId('pgid') }));
    vi.stubEnv('AGENT_TTY_SESSION_ID', 'session-01');
    Object.defineProperty(process, 'platform', { value: 'win32' });

    expect(await cliRunsInsideProgramSession('session-01')).toBe(false);
  });
});

describe('isProcessGroupAlive', () => {
  const platform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  function probeEnds(outcome: 'ok' | 'EPERM'): void {
    if (outcome === 'ok') {
      vi.spyOn(process, 'kill').mockReturnValue(true);
    } else {
      killFailsWith(outcome);
    }
  }

  it.each([
    ['ok', ['Z', 'X'], false],
    ['ok', ['Z', 'S'], true],
    ['ok', [], false],
    ['EPERM', ['Z'], false],
    ['EPERM', ['R'], true],
    ['EPERM', [], true],
  ] as const)(
    'on linux, when the probe ends %s and the group shows %j, returns %s',
    (outcome, states, alive) => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      procShowsGroup(...states);
      probeEnds(outcome);

      expect(isProcessGroupAlive(CHILD_PID)).toBe(alive);
    },
  );

  it.each(['ok', 'EPERM'] as const)(
    'on darwin, when the probe ends %s, counts a zombie as alive',
    (outcome) => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      procShowsGroup('Z');
      probeEnds(outcome);

      expect(isProcessGroupAlive(CHILD_PID)).toBe(true);
    },
  );

  // hidepid=1 lists the processes of other users but refuses their reads,
  // so a process that refuses its read can be a live one of the group.
  it.each([
    ['ok', 'EPERM'],
    ['ok', 'EACCES'],
    ['EPERM', 'EPERM'],
    ['EPERM', 'EACCES'],
  ] as const)(
    'on linux, when the probe ends %s, counts a zombie group alive while a process refuses its read with %s',
    (outcome, readError) => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      procShowsGroup('Z');
      fsHooks.proc?.set('3', errno(readError));
      probeEnds(outcome);

      expect(isProcessGroupAlive(CHILD_PID)).toBe(true);
    },
  );

  it.each([
    'hidepid=2',
    'hidepid=invisible',
    'hidepid=4',
    'hidepid=ptraceable',
  ])(
    'on linux, when /proc is mounted with %s, counts a zombie group alive',
    (option) => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      fsHooks.mountinfo = procMount(`rw,${option}`);
      procShowsGroup('Z');
      probeEnds('ok');

      expect(isProcessGroupAlive(CHILD_PID)).toBe(true);
    },
  );

  it('on linux, when a hidepid /proc is mounted over a plain one, counts a zombie group alive', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    fsHooks.mountinfo =
      procMount('rw') +
      procMount('rw,hidepid=invisible').replace('22 1 ', '23 22 ');
    procShowsGroup('Z');
    probeEnds('ok');

    expect(isProcessGroupAlive(CHILD_PID)).toBe(true);
  });

  it('on linux, when mountinfo cannot be read, counts a zombie group alive', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    procShowsGroup('Z');
    fsHooks.mountinfo = undefined;
    probeEnds('ok');

    expect(isProcessGroupAlive(CHILD_PID)).toBe(true);
  });

  it('returns false when the probe fails with ESRCH', () => {
    procShowsGroup('S');
    killFailsWith('ESRCH');

    expect(isProcessGroupAlive(CHILD_PID)).toBe(false);
  });
});

describe('killProcessGroupBestEffort', () => {
  const platform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it.each([
    ['linux', -CHILD_PID],
    ['darwin', -CHILD_PID],
    ['win32', CHILD_PID],
  ])('on %s signals %i', (name, target) => {
    Object.defineProperty(process, 'platform', { value: name });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    killProcessGroupBestEffort(CHILD_PID);

    expect(kill).toHaveBeenCalledExactlyOnceWith(target, 'SIGKILL');
  });

  it.each(['EPERM', 'ESRCH'])('ignores a kill that fails with %s', (code) => {
    killFailsWith(code);

    expect(() => {
      killProcessGroupBestEffort(CHILD_PID);
    }).not.toThrow();
  });

  it.each([0, 1])('refuses the group id %i', (pgid) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(() => killProcessGroupBestEffort(pgid)).toThrow(
      'process group id must be an integer above 1',
    );
    expect(kill).not.toHaveBeenCalled();
  });
});
