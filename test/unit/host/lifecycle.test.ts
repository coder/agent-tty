import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  afterReadFile: undefined as ((path: string) => Promise<void>) | undefined,
  beforeRename: undefined as ((target: string) => void) | undefined,
  // /proc/<pid>/stat by pid, or the error that its read throws.
  proc: undefined as Map<string, string | Error> | undefined,
  mountinfo: undefined as string | undefined,
  ownStatError: undefined as Error | undefined,
  noProc: false,
  // The text that a read of /proc/self/stat returns.
  ownStat: undefined as string | undefined,
  rmdirError: undefined as Error | undefined,
  files: undefined as Map<string, string | Error> | undefined,
  links: undefined as Map<string, string | Error> | undefined,
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
    const file = fsHooks.files?.get(path);
    if (file instanceof Error) {
      throw file;
    }
    if (file !== undefined) {
      return file;
    }
    if (fsHooks.ownStatError !== undefined && path === '/proc/self/stat') {
      throw fsHooks.ownStatError;
    }
    if (fsHooks.noProc && path.startsWith('/proc/')) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    if (fsHooks.ownStat !== undefined && path === '/proc/self/stat') {
      return fsHooks.ownStat;
    }
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
  // noProc leaves /proc an empty mount point.
  const existsSync = ((path: Fs.PathLike) =>
    fsHooks.noProc && typeof path === 'string' && path.startsWith('/proc/')
      ? false
      : actual.existsSync(path)) as typeof actual.existsSync;
  const readlinkSync = ((path: string, ...rest: unknown[]) => {
    const link = fsHooks.links?.get(path);
    if (link instanceof Error) {
      throw link;
    }
    return (
      link ??
      (actual.readlinkSync as (...args: unknown[]) => unknown)(path, ...rest)
    );
  }) as typeof actual.readlinkSync;
  return { ...actual, existsSync, readdirSync, readFileSync, readlinkSync };
});

// The controlling terminal that /bin/ps prints for a pid, or null when ps
// finds no such process.
const psHooks = vi.hoisted(() => ({
  tty: undefined as ((pid: number) => string | null) | undefined,
}));

// The last ChildProcess that spawn returned, so a test can watch the host
// that launchHost started.
const spawnHooks = vi.hoisted(() => ({
  last: undefined as unknown,
}));

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof ChildProcess>('node:child_process');
  const spawn = ((...args: unknown[]) => {
    const child = (
      actual.spawn as (...all: unknown[]) => ChildProcess.ChildProcess
    )(...args);
    spawnHooks.last = child;
    return child;
  }) as typeof actual.spawn;
  const execFileSync = ((file: string, args: readonly string[], ...rest) => {
    if (psHooks.tty !== undefined && file === '/bin/ps' && args[1] === 'tty=') {
      const tty = psHooks.tty(Number(args[3]));
      if (tty === null) {
        throw Object.assign(new Error('ps exited 1'), { status: 1 });
      }
      return `${tty}\n`;
    }
    return (actual.execFileSync as (...all: unknown[]) => unknown)(
      file,
      args,
      ...rest,
    );
  }) as typeof actual.execFileSync;
  return { ...actual, execFileSync, spawn };
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
  const rename = async (
    ...args: Parameters<typeof actual.rename>
  ): Promise<void> => {
    if (typeof args[1] === 'string') {
      fsHooks.beforeRename?.(args[1]);
    }
    await actual.rename(...args);
  };
  const rmdir = async (
    ...args: Parameters<typeof actual.rmdir>
  ): Promise<void> => {
    if (fsHooks.rmdirError !== undefined) {
      throw fsHooks.rmdirError;
    }
    await actual.rmdir(...args);
  };
  return { ...actual, readFile, rename, rmdir };
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

import type * as ChildProcess from 'node:child_process';
import type * as Fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type * as TimersPromises from 'node:timers/promises';

import {
  allocateSession,
  destroySession,
  listSessions,
  cliRunsInsideProgramSession,
  launchHost,
  reconcileSession,
  removeSocketDirectoryBestEffort,
  removeSocketDirectoryIfEmpty,
  type AllocateConfig,
  type LaunchedHost,
} from '../../../src/host/lifecycle.js';
import {
  captureProgram,
  writeProgramRecord,
  type ProgramRecord,
} from '../../../src/host/programGroup.js';
import {
  captureHost,
  writeHostRecord,
  type HostRecord,
} from '../../../src/host/hostRecord.js';
import { ensureSocketRoot } from '../../../src/host/socketRoot.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';
import { readManifest, writeManifest } from '../../../src/storage/manifests.js';
import {
  hostRecordPath,
  legacySocketPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../../../src/storage/sessionPaths.js';
import { capturesToken, killGroupIfAlive } from '../../helpers.js';

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
  psHooks.tty = undefined;
  fsHooks.ownStatError = undefined;
  fsHooks.noProc = false;
  fsHooks.ownStat = undefined;
  fsHooks.files = undefined;
  fsHooks.links = undefined;
  fsHooks.beforeRename = undefined;
  await rm(home, { recursive: true, force: true });
});

// A token proves the group only with a host.json that names this pid space.
function recordOwnPidSpace(directory: string): void {
  writeHostRecord(directory, {
    ...(captureHost(process.pid) as HostRecord),
    pid: HOST_PID,
  });
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function procMount(options: string): string {
  return `22 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc ${options}\n`;
}

// The fields of /proc/<pid>/stat after the session id, up to the start time.
const STAT_TAIL = '0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 100';

// /proc shows one process of the program's group per state, under a command
// name with spaces and parentheses, beside a process of another group and a
// process that ends during the scan. Unless the test set its own, /proc is
// mounted without hidepid, so the result does not depend on the host.
function procShowsGroup(...states: string[]): void {
  fsHooks.mountinfo ??= procMount('rw');
  fsHooks.proc = new Map<string, string | Error>([
    ['1', `1 (init) S 0 1 1 ${STAT_TAIL}`],
    ['2', errno('ESRCH')],
  ]);
  states.forEach((state, index) => {
    const pid = String(100 + index);
    fsHooks.proc?.set(
      pid,
      `${pid} (a) b (c) ${state} 1 ${String(CHILD_PID)} ${String(CHILD_PID)} ${STAT_TAIL}`,
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

  // A CLI in another pid namespace finds no process with the host's pid. A
  // host.json from the start on keeps it from reading the host dead.
  it.runIf(process.platform === 'linux')(
    'records the host before the first manifest names it',
    async () => {
      const host = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      try {
        await once(host, 'spawn');
        const hostPid = host.pid as number;
        const hostRecordAtFirstManifest: boolean[] = [];
        fsHooks.beforeRename = (target) => {
          if (target.endsWith('/session.json')) {
            hostRecordAtFirstManifest.push(
              existsSync(hostRecordPath(dirname(target))),
            );
          }
        };
        const result = await allocateSession(makeConfig(), () => hostPid);
        expect(hostRecordAtFirstManifest).toEqual([true]);
        fsHooks.links = new Map([['/proc/self/ns/pid', 'pid:[1]']]);
        const kill = process.kill.bind(process);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === hostPid && signal === 0) {
            throw errno('ESRCH');
          }
          return kill(pid, signal);
        });

        await reconcileSession(result.sessionDirectory);

        expect(
          await readManifest(manifestPath(result.sessionDirectory)),
        ).toMatchObject({ status: 'running', hostPid });
      } finally {
        host.kill('SIGKILL');
      }
    },
  );

  it('does not launch a host when the working directory does not exist', async () => {
    const launch = vi.fn(() => 4242);

    await expect(
      allocateSession(makeConfig({ cwd: join(home, 'missing') }), launch),
    ).rejects.toMatchObject({ code: 'STORAGE_READ_ERROR' });
    expect(launch).not.toHaveBeenCalled();
  });

  // The program never gets the destroy re-run marker, so the manifest that
  // inspect shows does not name it either.
  it.each([
    [{ FOO: 'bar', AGENT_TTY_DESTROY_RERUN: '1' }, { FOO: 'bar' }],
    [{ AGENT_TTY_DESTROY_RERUN: '1' }, undefined],
  ])('records the env %o as %o', async (env, recorded) => {
    const result = await allocateSession(makeConfig({ env }), () => 4242);

    expect(
      (await readManifest(manifestPath(result.sessionDirectory))).env,
    ).toEqual(recorded);
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

describe('launchHost', () => {
  function launchFixture(source: string): {
    host: LaunchedHost;
    child: ChildProcess.ChildProcess;
  } {
    const entrypoint = join(home, 'host.mjs');
    writeFileSync(entrypoint, source);
    const cliArgv = process.argv;
    process.argv = [...cliArgv.slice(0, 1), entrypoint, ...cliArgv.slice(2)];
    try {
      const host = launchHost({
        sessionId: 'session-01',
        home,
        env: {},
        term: 'xterm-256color',
      });
      const child = spawnHooks.last as ChildProcess.ChildProcess;
      expect(child.pid).toBe(host.pid);
      return { host, child };
    } finally {
      process.argv = cliArgv;
    }
  }

  it('stop sends a running host SIGTERM', async () => {
    const { host, child } = launchFixture('setInterval(() => {}, 1000);\n');
    const exit = once(child, 'exit');

    host.stop();

    expect(child.killed).toBe(true);
    expect(await exit).toEqual([null, 'SIGTERM']);
  });

  it('stop sends nothing once the host has exited', async () => {
    const { host, child } = launchFixture('process.exit(0);\n');
    const errors: unknown[] = [];
    child.on('error', (error) => errors.push(error));
    expect(await once(child, 'exit')).toEqual([0, null]);

    expect(() => {
      host.stop();
    }).not.toThrow();

    expect(child.killed).toBe(false);
    expect(errors).toEqual([]);
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

  it('restores destroyed when a destroy marked the folder before this write', async () => {
    const directory = await seedSession(makeRecord());
    killProbeReportsDead();
    writeFileSync(join(directory, 'destroyed'), '');

    await reconcileSession(directory);

    const manifest = await readManifest(manifestPath(directory));
    expect(manifest).toMatchObject({
      status: 'destroyed',
      hostPid: null,
      childPid: null,
    });
    expect(manifest.failureReason).toBeUndefined();
  });

  it('records destroyed for a failed session whose reconcile died before it repaired a destroy', async () => {
    const directory = await seedSession(
      makeRecord({
        status: 'failed',
        failureOrigin: 'host-death',
        failureReason: 'host process died unexpectedly',
        hostPid: null,
        childPid: null,
      }),
    );
    writeFileSync(join(directory, 'destroyed'), '');

    await reconcileSession(directory);

    const manifest = await readManifest(manifestPath(directory));
    expect(manifest).toMatchObject({ status: 'destroyed' });
    expect(manifest.failureOrigin).toBeUndefined();
    expect(manifest.failureReason).toBeUndefined();
  });

  it('records destroyed for an exited session whose destroy failed after the marker', async () => {
    const directory = await seedSession(
      makeRecord({
        status: 'exited',
        exitCode: 3,
        hostPid: null,
        childPid: null,
      }),
    );
    writeFileSync(join(directory, 'destroyed'), '');

    await reconcileSession(directory);

    expect(await readManifest(manifestPath(directory))).toMatchObject({
      status: 'destroyed',
      exitCode: 3,
    });
  });

  it('list shows destroyed for a failed session next to the destroy marker', async () => {
    const directory = await seedSession(
      makeRecord({
        status: 'failed',
        failureOrigin: 'host-death',
        hostPid: null,
        childPid: null,
      }),
    );
    writeFileSync(join(directory, 'destroyed'), '');

    const [summary] = await listSessions(home, true);

    expect(summary).toMatchObject({
      sessionId: 'session-01',
      status: 'destroyed',
    });
  });

  it('removes the socket that a dead host left when it repairs a destroy', async () => {
    const directory = await seedSession(
      makeRecord({
        status: 'failed',
        failureOrigin: 'host-death',
        hostPid: null,
        childPid: null,
      }),
    );
    writeFileSync(join(directory, 'destroyed'), '');
    const socketFile = socketPath(directory);
    await mkdir(dirname(socketFile), { recursive: true, mode: 0o700 });
    writeFileSync(socketFile, '');

    try {
      await reconcileSession(directory);

      expect(existsSync(socketFile)).toBe(false);
      expect(existsSync(dirname(socketFile))).toBe(false);
    } finally {
      await rm(dirname(socketFile), { recursive: true, force: true });
    }
  });

  it('leaves a running session with a live host as it is next to the destroy marker', async () => {
    const running = makeRecord({ hostPid: process.pid, childPid: null });
    const directory = await seedSession(running);
    const own = captureHost(process.pid);
    if (own !== null) {
      writeHostRecord(directory, own);
    }
    writeFileSync(join(directory, 'destroyed'), '');

    await reconcileSession(directory);
    expect(await readManifest(manifestPath(directory))).toEqual(running);
    expect(await listSessions(home, true)).toMatchObject([
      { sessionId: 'session-01', status: 'running' },
    ]);
  });

  it('list shows destroyed when the socket cleanup fails after the repair write', async () => {
    const directory = await seedSession(
      makeRecord({
        status: 'failed',
        failureOrigin: 'host-death',
        hostPid: null,
        childPid: null,
      }),
    );
    writeFileSync(join(directory, 'destroyed'), '');
    // unlink of a directory fails with EISDIR (EPERM on macOS).
    const socketFile = socketPath(directory);
    await mkdir(socketFile, { recursive: true });

    try {
      expect(await listSessions(home, true)).toMatchObject([
        { sessionId: 'session-01', status: 'destroyed' },
      ]);
    } finally {
      await rm(dirname(socketFile), { recursive: true, force: true });
    }
  });

  // A root process can write into a folder of mode 0500.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'list keeps a marked failed session when its repair write fails',
    async () => {
      const directory = await seedSession(
        makeRecord({
          status: 'failed',
          failureOrigin: 'host-death',
          hostPid: null,
          childPid: null,
        }),
      );
      writeFileSync(join(directory, 'destroyed'), '');
      await chmod(directory, 0o500);

      try {
        expect(await listSessions(home, true)).toMatchObject([
          { sessionId: 'session-01', status: 'failed' },
        ]);
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );

  it('leaves an exited session without the marker as it is', async () => {
    const exited = makeRecord({
      status: 'exited',
      exitCode: 0,
      hostPid: null,
      childPid: null,
    });
    const directory = await seedSession(exited);

    await reconcileSession(directory);

    expect(await readManifest(manifestPath(directory))).toEqual(exited);
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

  it('kills no group when gc removes the folder after the re-read', async () => {
    const directory = await seedSession(makeRecord());
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    gcRemovesFolderAfterRead(directory, 2);

    await reconcileSession(directory);

    expect(kill).not.toHaveBeenCalledWith(-CHILD_PID, 'SIGKILL');
  });

  it('kills the group of the manifest when the program record has no token', async () => {
    const directory = await seedSession(makeRecord());
    writeProgramRecord(directory, {
      version: 1,
      pid: CHILD_PID,
      bootId: null,
      autogroup: null,
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });

    await reconcileSession(directory);

    expect(kill).toHaveBeenCalledWith(-CHILD_PID, 'SIGKILL');
  });

  describe.runIf(capturesToken)('with a token', () => {
    let group = 0;

    afterEach(() => {
      if (group > 1) {
        killGroupIfAlive(group);
      }
      group = 0;
    });

    async function seedProgramGroup(
      change: (record: ProgramRecord) => ProgramRecord,
    ) {
      group = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
        .pid as number;
      const record = captureProgram(group);
      expect(record.autogroup).not.toBeNull();
      const directory = await seedSession(makeRecord({ childPid: group }));
      writeProgramRecord(directory, change(record));
      recordOwnPidSpace(directory);
      const send = process.kill.bind(process);
      const kill = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid, signal) => {
          if (pid === HOST_PID) {
            throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
          }
          const sent = send(pid, signal);
          if (pid === -group && signal === 'SIGKILL') {
            waitUntilDead(group);
          }
          return sent;
        });
      return { directory, kill };
    }

    // The mocked timers make the wait after the kill a few event-loop turns
    // long, so the kill waits here until the kernel has ended the process.
    function waitUntilDead(pid: number): void {
      const deadline = Date.now() + 10_000;
      for (;;) {
        let stat: string;
        try {
          stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
        } catch {
          return;
        }
        const state = stat.slice(
          stat.lastIndexOf(')') + 2,
          stat.lastIndexOf(')') + 3,
        );
        if (state === 'Z' || state === 'X') {
          return;
        }
        expect(Date.now()).toBeLessThan(deadline);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }

    it('kills the group that the record proves', async () => {
      const { directory, kill } = await seedProgramGroup((record) => record);

      await reconcileSession(directory);

      expect(kill).toHaveBeenCalledWith(-group, 'SIGKILL');
      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'failed',
      });
    });

    it.each([
      [
        'another autogroup',
        (record: ProgramRecord) =>
          record.autogroup === null
            ? record
            : { ...record, autogroup: record.autogroup + 1 },
      ],
      [
        'another boot',
        (record: ProgramRecord) =>
          record.bootId === null
            ? record
            : { ...record, bootId: '00000000-0000-0000-0000-000000000000' },
      ],
    ])('does not kill a group whose record names %s', async (_name, change) => {
      const { directory, kill } = await seedProgramGroup(change);

      await reconcileSession(directory);

      expect(kill).not.toHaveBeenCalledWith(-group, 'SIGKILL');
      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'failed',
      });
    });
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

  it('marks the folder before it records destroyed', async () => {
    vi.stubEnv('AGENT_TTY_HOME', home);
    const directory = await seedSession(makeRecord());
    killProbeReportsDead();

    await destroySession('session-01', true);

    expect(existsSync(join(directory, 'destroyed'))).toBe(true);
    expect(await readManifest(manifestPath(directory))).toMatchObject({
      status: 'destroyed',
    });
  });

  it('replaces a symlink at the marker path instead of writing through it', async () => {
    vi.stubEnv('AGENT_TTY_HOME', home);
    const directory = await seedSession(makeRecord());
    const outside = join(home, 'outside.txt');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(directory, 'destroyed'));
    killProbeReportsDead();

    await destroySession('session-01', true);

    expect(readFileSync(outside, 'utf8')).toBe('keep');
    const marker = lstatSync(join(directory, 'destroyed'));
    expect(marker.isFile()).toBe(true);
    expect(marker.size).toBe(0);
  });

  describe('of a session whose program exited', () => {
    const exited = makeRecord({ status: 'exited', exitCode: 0 });

    beforeEach(() => {
      vi.stubEnv('AGENT_TTY_HOME', home);
    });

    it('kills nothing when the program record has no token', async () => {
      const directory = await seedSession(exited);
      writeProgramRecord(directory, {
        version: 1,
        pid: CHILD_PID,
        bootId: null,
        autogroup: null,
      });
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

      await destroySession('session-01');

      expect(kill).not.toHaveBeenCalled();
      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'destroyed',
      });
    });

    describe.runIf(capturesToken)('and left a process in its group', () => {
      let group = 0;

      afterEach(() => {
        vi.restoreAllMocks();
        if (group > 1) {
          killGroupIfAlive(group);
        }
        group = 0;
      });

      async function seedLeftover(): Promise<string> {
        group = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
          .pid as number;
        const record = captureProgram(group);
        expect(record.autogroup).not.toBeNull();
        const directory = await seedSession(exited);
        writeProgramRecord(directory, record);
        recordOwnPidSpace(directory);
        return directory;
      }

      it('kills the group that the record proves', async () => {
        const directory = await seedLeftover();
        const kill = vi.spyOn(process, 'kill');

        await destroySession('session-01');

        expect(kill).toHaveBeenCalledWith(-group, 'SIGKILL');
        expect(kill).not.toHaveBeenCalledWith(HOST_PID, 'SIGKILL');
        expect(await readManifest(manifestPath(directory))).toMatchObject({
          status: 'destroyed',
        });
      });

      // Only a read that fails before the first verdict on the group lets
      // destroy --force record destroyed without it. After a verdict that
      // the group runs, a failed read leaves the group running.
      it('destroy --force fails, and records nothing, when a read fails after the group read owned', async () => {
        const directory = await seedLeftover();
        const stat = `/proc/${String(group)}/stat`;
        let reads = 0;
        fsHooks.files = new (class extends Map<string, string | Error> {
          override get(path: string): string | Error | undefined {
            if (path !== stat) {
              return undefined;
            }
            reads += 1;
            return reads > 1 ? errno('EIO') : undefined;
          }
        })();
        const kill = vi.spyOn(process, 'kill');

        await expect(destroySession('session-01', true)).rejects.toMatchObject({
          code: 'EIO',
        });
        expect(kill).not.toHaveBeenCalledWith(-group, 'SIGKILL');
        expect(await readManifest(manifestPath(directory))).toEqual(exited);
        expect(reads).toBeGreaterThan(1);
      });

      it('destroy --force records destroyed, and kills nothing, when the first read of the group fails twice', async () => {
        const directory = await seedLeftover();
        fsHooks.files = new Map([
          [`/proc/${String(group)}/stat`, errno('EIO')],
        ]);
        const kill = vi.spyOn(process, 'kill');

        await destroySession('session-01', true);

        expect(kill).not.toHaveBeenCalledWith(-group, 'SIGKILL');
        expect(await readManifest(manifestPath(directory))).toMatchObject({
          status: 'destroyed',
        });
      });

      // A read can fail once, as on a network file system, and pass the
      // next time, 100 ms later.
      it('destroy --force kills the group when only the first read of the group fails', async () => {
        const directory = await seedLeftover();
        const stat = `/proc/${String(group)}/stat`;
        let reads = 0;
        fsHooks.files = new (class extends Map<string, string | Error> {
          override get(path: string): string | Error | undefined {
            if (path !== stat) {
              return undefined;
            }
            reads += 1;
            return reads === 1 ? errno('EIO') : undefined;
          }
        })();
        const kill = vi.spyOn(process, 'kill');

        await destroySession('session-01', true);

        expect(kill).toHaveBeenCalledWith(-group, 'SIGKILL');
        expect(await readManifest(manifestPath(directory))).toMatchObject({
          status: 'destroyed',
        });
        expect(reads).toBeGreaterThan(1);
      });

      it('destroy --force stops at an abort between the two reads of the group', async () => {
        const directory = await seedLeftover();
        const controller = new AbortController();
        const reason = new Error('destroy aborted');
        const stat = `/proc/${String(group)}/stat`;
        let reads = 0;
        fsHooks.files = new (class extends Map<string, string | Error> {
          override get(path: string): string | Error | undefined {
            if (path !== stat) {
              return undefined;
            }
            reads += 1;
            controller.abort(reason);
            return errno('EIO');
          }
        })();
        const kill = vi.spyOn(process, 'kill');

        await expect(
          destroySession('session-01', true, { signal: controller.signal }),
        ).rejects.toBe(reason);
        expect(reads).toBe(1);
        expect(kill).not.toHaveBeenCalledWith(-group, 'SIGKILL');
        expect(await readManifest(manifestPath(directory))).toEqual(exited);
      });

      it('times out without recording destroyed while the group survives its kill', async () => {
        const directory = await seedLeftover();
        const send = process.kill.bind(process);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === -group) {
            throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
          }
          return send(pid, signal);
        });

        await expect(destroySession('session-01')).rejects.toMatchObject({
          code: 'HOST_TIMEOUT',
        });
        expect(await readManifest(manifestPath(directory))).toEqual(exited);
      });

      // From another pid namespace no scan or probe shows the group, and a
      // CLI without /proc cannot read its own pid namespace either. A
      // host.json that cannot be read counts as missing.
      it.each([
        ['host.json names another pid namespace', 'namespace' as const],
        ['the CLI cannot read /proc', 'noProc' as const],
        ['the CLI cannot read host.json', 'unreadable' as const],
      ])(
        'times out without a signal to the group when %s and no probe finds it',
        async (_, gap) => {
          const directory = await seedLeftover();
          const own = captureHost(process.pid);
          expect(own).not.toBeNull();
          writeHostRecord(directory, {
            ...(own as HostRecord),
            ...(gap === 'namespace' && { pidNamespace: 'pid:[1]' }),
          });
          if (gap === 'unreadable') {
            await rm(hostRecordPath(directory));
            await mkdir(hostRecordPath(directory));
          }
          fsHooks.proc = new Map();
          if (gap === 'noProc') {
            fsHooks.noProc = true;
            fsHooks.links = new Map([['/proc/self/ns/pid', errno('ENOENT')]]);
          }
          const send = process.kill.bind(process);
          const kill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid, signal) => {
              if (pid === -group) {
                throw errno('ESRCH');
              }
              return send(pid, signal);
            });

          await expect(destroySession('session-01')).rejects.toMatchObject({
            code: 'HOST_TIMEOUT',
            message: expect.stringContaining(
              {
                namespace:
                  "Run destroy from the host's pid namespace on the host's machine.",
                noProc: 'Run destroy where /proc is mounted.',
                unreadable: `This process cannot read the host record at ${hostRecordPath(directory)}`,
              }[gap],
            ) as string,
          });
          expect(kill.mock.calls.filter(([pid]) => pid === -group)).toEqual([]);
          expect(await readManifest(manifestPath(directory))).toEqual(exited);
        },
      );
    });
  });
});

describe('a hostPid that may no longer name the host', () => {
  const platform = process.platform;
  const started: ReturnType<typeof spawn>[] = [];

  function startProcess(...args: string[]): number {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', ...args],
      { stdio: 'ignore' },
    );
    started.push(child);
    expect(child.pid).toBeTypeOf('number');
    return child.pid as number;
  }

  // The parent never waits, so its child stays a zombie. A shell does not
  // do: dash reaps a background child that ends before the shell reaches
  // its next command, and then no zombie appears.
  async function startZombie(): Promise<number> {
    const parent = spawn(
      'python3',
      [
        '-c',
        'import os, time\npid = os.fork()\nif pid == 0:\n    os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)',
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    started.push(parent);
    const [line] = (await once(parent.stdout, 'data')) as [Buffer];
    const pid = Number(line.toString().trim());
    await vi.waitFor(
      () => {
        expect(
          execFileSync('ps', ['-o', 's=', '-p', String(pid)], {
            encoding: 'utf8',
          }).trim(),
        ).toBe('Z');
      },
      { timeout: 3000 },
    );
    return pid;
  }

  function isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function reapAsInitAfterKill(host: number) {
    const send = process.kill.bind(process);
    let killed = false;
    return vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === host && killed && signal === 0) {
        throw errno('ESRCH');
      }
      killed ||= pid === host && signal === 'SIGKILL';
      return send(pid, signal);
    });
  }

  async function seedHost(
    hostPid: number,
    record: 'none' | 'own' | 'earlierHost' | Partial<HostRecord> = 'own',
  ): Promise<string> {
    vi.stubEnv('AGENT_TTY_HOME', home);
    const directory = await seedSession(
      makeRecord({ hostPid, childPid: null }),
    );
    const own = record === 'none' ? null : captureHost(hostPid);
    if (own !== null && record !== 'none') {
      writeHostRecord(
        directory,
        record === 'own'
          ? own
          : record === 'earlierHost'
            ? { ...own, startTicks: '1' }
            : { ...own, ...record },
      );
    }
    return directory;
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    for (const child of started.splice(0)) {
      child.kill('SIGKILL');
    }
  });

  it.each([
    ['runs the host of that session', ['_host', 'session-01', '1']],
    ['has an earlier _host argument', ['_host', 'x', '_host', 'session-01']],
    ['has no _host argument', []],
  ])(
    'reconcile leaves the session running while its hostPid %s',
    async (_, args) => {
      const directory = await seedHost(startProcess(...args));
      const record = await readManifest(manifestPath(directory));

      await reconcileSession(directory);

      expect(await readManifest(manifestPath(directory))).toEqual(record);
    },
  );

  it.runIf(platform === 'linux')(
    'on linux destroy --force kills a host whose title replaced its command line',
    async () => {
      const child = spawn(
        process.execPath,
        ['--title=renamed-host', '-e', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore' },
      );
      started.push(child);
      const host = child.pid as number;
      await vi.waitFor(() => {
        expect(readFileSync(`/proc/${String(host)}/cmdline`, 'utf8')).toMatch(
          /^renamed-host/,
        );
      });
      const directory = await seedHost(host);
      const kill = reapAsInitAfterKill(host);

      await destroySession('session-01', true);

      expect(kill).toHaveBeenCalledWith(host, 'SIGKILL');
      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'destroyed',
      });
    },
  );

  it.runIf(platform === 'linux')(
    'on linux reconcile records failed when another process got the hostPid',
    async () => {
      const directory = await seedHost(startProcess(), 'earlierHost');

      await reconcileSession(directory);

      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'failed',
        failureOrigin: 'host-death',
      });
    },
  );

  it.runIf(platform === 'linux')(
    'on linux reconcile records failed when the host stays a zombie',
    async () => {
      const directory = await seedHost(await startZombie(), 'none');

      await reconcileSession(directory);

      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'failed',
      });
    },
  );

  it.runIf(platform === 'linux')(
    'on linux destroy --force records destroyed without killing a process that got the hostPid',
    async () => {
      const other = startProcess();
      const directory = await seedHost(other, 'earlierHost');

      await destroySession('session-01', true);

      expect(isRunning(other)).toBe(true);
      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'destroyed',
      });
    },
  );

  it.runIf(platform === 'linux')(
    'on linux destroy --force records destroyed when the host stays a zombie',
    async () => {
      const directory = await seedHost(await startZombie(), 'none');

      await destroySession('session-01', true);

      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'destroyed',
      });
    },
  );

  it.runIf(platform === 'linux').each([
    ['/proc is not mounted', 'none' as const],
    ['/proc refuses the stat of the host', 'refused' as const],
    ['no host record exists', 'record' as const],
  ])(
    'on linux, when %s, a live host stays running and gets no kill',
    async (_, gap) => {
      const host = startProcess('_host', 'session-01', '1');
      const directory = await seedHost(host, gap === 'record' ? 'none' : 'own');
      const record = await readManifest(manifestPath(directory));
      if (gap === 'none') {
        fsHooks.noProc = true;
      } else if (gap === 'refused') {
        fsHooks.proc = new Map([[String(host), errno('EACCES')]]);
      }

      await reconcileSession(directory);
      expect(await readManifest(manifestPath(directory))).toEqual(record);

      await expect(destroySession('session-01', true)).rejects.toMatchObject({
        code: 'HOST_TIMEOUT',
        message: (gap === 'none'
          ? expect.stringContaining('cannot read /proc')
          : expect.not.stringContaining('/proc')) as string,
      });
      expect(isRunning(host)).toBe(true);
      expect(await readManifest(manifestPath(directory))).toEqual(record);
    },
  );

  // Without /proc a host.json makes even a dead host read unknown, but no
  // process with its pid proves that no host can end the session.
  it.runIf(platform === 'linux')(
    'on linux destroy --force without /proc names no plain destroy once no process has the host pid',
    async () => {
      const host = startProcess('_host', 'session-01', '1');
      await seedHost(host);
      process.kill(host, 'SIGKILL');
      await vi.waitFor(() => {
        expect(isRunning(host)).toBe(false);
      });
      fsHooks.noProc = true;
      fsHooks.links = new Map([['/proc/self/ns/pid', errno('ENOENT')]]);

      const error: unknown = await destroySession('session-01', true).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toMatchObject({ code: 'HOST_TIMEOUT' });
      expect((error as Error).message).toContain(
        'Run destroy where /proc is mounted.',
      );
      expect((error as Error).message).not.toContain('plain destroy');
    },
  );

  it.runIf(platform === 'linux').each([
    ['an unrelated live process', 'live' as const],
    ['no process', 'free' as const],
  ])(
    'on linux a hostPid that a host in another pid namespace recorded, which names %s here, gets no kill and no record',
    async (_, here) => {
      const other = startProcess();
      const directory = await seedHost(other, { pidNamespace: 'pid:[1]' });
      if (here === 'free') {
        process.kill(other, 'SIGKILL');
        await vi.waitFor(() => {
          expect(isRunning(other)).toBe(false);
        });
      }
      const record = await readManifest(manifestPath(directory));
      const kill = vi.spyOn(process, 'kill');

      await reconcileSession(directory);
      expect(await readManifest(manifestPath(directory))).toEqual(record);

      await expect(destroySession('session-01', true)).rejects.toMatchObject({
        code: 'HOST_TIMEOUT',
      });
      expect(kill).not.toHaveBeenCalledWith(other, 'SIGKILL');
      expect(await readManifest(manifestPath(directory))).toEqual(record);
    },
  );

  function shiftStartTicks(stat: string, ticks: bigint): string {
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    fields[19] = String(BigInt(fields[19] ?? '') + ticks);
    return `${stat.slice(0, close + 2)}${fields.join(' ')}`;
  }

  // /proc/<pid>/stat shows the start time with the reader's boottime offset.
  it.runIf(platform === 'linux')(
    'on linux a CLI in another time namespace leaves a live host running and kills nothing',
    async () => {
      const host = startProcess('_host', 'session-01', '1');
      const directory = await seedHost(host);
      const record = await readManifest(manifestPath(directory));
      const statPath = `/proc/${String(host)}/stat`;
      fsHooks.files = new Map([
        [
          statPath,
          shiftStartTicks(readFileSync(statPath, 'utf8'), 10_000_000n),
        ],
      ]);
      fsHooks.links = new Map([['/proc/self/ns/time', 'time:[1]']]);
      const kill = vi.spyOn(process, 'kill');

      await reconcileSession(directory);
      expect(await readManifest(manifestPath(directory))).toEqual(record);

      await expect(destroySession('session-01', true)).rejects.toMatchObject({
        code: 'HOST_TIMEOUT',
      });
      expect(kill).not.toHaveBeenCalledWith(host, 'SIGKILL');
      expect(isRunning(host)).toBe(true);
    },
  );

  it.runIf(platform === 'linux')(
    'on linux destroy --force kills a host whose record predates the identity fields',
    async () => {
      const host = startProcess('_host', 'session-01', '1');
      const directory = await seedHost(host, 'none');
      const own = captureHost(host);
      expect(own).not.toBeNull();
      const {
        timeNamespace: _time,
        machineId: _machine,
        ...legacy
      } = own as HostRecord;
      writeFileSync(join(directory, 'host.json'), JSON.stringify(legacy));
      const kill = reapAsInitAfterKill(host);

      await destroySession('session-01', true);

      expect(kill).toHaveBeenCalledWith(host, 'SIGKILL');
      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'destroyed',
      });
    },
  );

  it.runIf(platform === 'linux').each([
    [
      'uninitialized\n',
      'fedcba9876543210fedcba9876543210\n',
      'fedcba9876543210fedcba9876543210',
    ],
    ['uninitialized\n', 'not-a-machine-id\n', null],
  ])(
    'on linux the host record reads /etc/machine-id %j and the dbus id %j as machine id %j',
    (etc, dbus, expected) => {
      fsHooks.files = new Map<string, string | Error>([
        ['/etc/machine-id', etc],
        ['/var/lib/dbus/machine-id', dbus],
      ]);

      expect(captureHost(process.pid)).toMatchObject({ machineId: expected });
    },
  );

  it.runIf(platform === 'linux')(
    'on linux the host record keeps the pid namespace when /proc refuses its time namespace',
    () => {
      fsHooks.links = new Map<string, string | Error>([
        [`/proc/${String(process.pid)}/ns/time`, errno('EACCES')],
      ]);

      expect(captureHost(process.pid)).toMatchObject({
        pidNamespace: readlinkSync('/proc/self/ns/pid'),
        timeNamespace: null,
      });
    },
  );

  // A host on a kernel without time namespaces, or one whose /proc refused
  // the link, records a null time namespace.
  it.runIf(platform === 'linux')(
    'on linux a host record without a time namespace proves the host to a CLI whose kernel has none either',
    async () => {
      const host = startProcess('_host', 'session-01', '1');
      await seedHost(host, { timeNamespace: null });
      fsHooks.links = new Map([['/proc/self/ns/time', errno('ENOENT')]]);
      const kill = reapAsInitAfterKill(host);

      await destroySession('session-01', true);

      expect(kill).toHaveBeenCalledWith(host, 'SIGKILL');
    },
  );

  it.runIf(platform === 'linux').each([
    ['has one', 'time:[1]'],
    ['refuses its own', errno('EACCES')],
  ])(
    'on linux a host record without a time namespace leaves the host running for a CLI whose kernel %s',
    async (_, ownLink) => {
      const host = startProcess('_host', 'session-01', '1');
      const directory = await seedHost(host, { timeNamespace: null });
      const record = await readManifest(manifestPath(directory));
      fsHooks.links = new Map<string, string | Error>([
        ['/proc/self/ns/time', ownLink],
      ]);
      const kill = vi.spyOn(process, 'kill');

      await reconcileSession(directory);
      expect(await readManifest(manifestPath(directory))).toEqual(record);

      await expect(destroySession('session-01', true)).rejects.toMatchObject({
        code: 'HOST_TIMEOUT',
      });
      expect(kill).not.toHaveBeenCalledWith(host, 'SIGKILL');
      expect(isRunning(host)).toBe(true);
    },
  );

  it.runIf(platform === 'linux')(
    'on linux the host record takes the dbus machine id when /etc/machine-id cannot be read',
    () => {
      fsHooks.files = new Map<string, string | Error>([
        ['/etc/machine-id', errno('EACCES')],
        ['/var/lib/dbus/machine-id', 'fedcba9876543210fedcba9876543210\n'],
      ]);

      expect(captureHost(process.pid)).toMatchObject({
        machineId: 'fedcba9876543210fedcba9876543210',
      });
    },
  );

  it.runIf(platform === 'linux')(
    'on linux a CLI in another time namespace still records failed for a host that stays a zombie',
    async () => {
      const zombie = await startZombie();
      const directory = await seedHost(zombie, 'none');
      const own = captureHost(process.pid);
      expect(own).not.toBeNull();
      writeHostRecord(directory, { ...(own as HostRecord), pid: zombie });
      fsHooks.links = new Map([['/proc/self/ns/time', 'time:[1]']]);

      await reconcileSession(directory);

      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'failed',
      });
    },
  );

  it.runIf(platform === 'linux')(
    'on linux a CLI on another machine that shares the Home leaves the host running and kills nothing',
    async () => {
      const host = startProcess('_host', 'session-01', '1');
      const directory = await seedHost(host);
      const record = await readManifest(manifestPath(directory));
      fsHooks.files = new Map([
        [
          '/proc/sys/kernel/random/boot_id',
          '4f2f7a8e-0c5e-4d34-9b6a-1c1d2e3f4a5b\n',
        ],
        ['/etc/machine-id', '0123456789abcdef0123456789abcdef\n'],
      ]);
      const kill = vi.spyOn(process, 'kill');

      await reconcileSession(directory);
      expect(await readManifest(manifestPath(directory))).toEqual(record);

      await expect(destroySession('session-01', true)).rejects.toMatchObject({
        code: 'HOST_TIMEOUT',
      });
      expect(kill).not.toHaveBeenCalledWith(host, 'SIGKILL');
      expect(isRunning(host)).toBe(true);
    },
  );

  it.skipIf(platform === 'win32').each([
    ['runs the host of that session', ['_host', 'session-01', '1']],
    ['has an earlier _host argument', ['_host', 'x', '_host', 'session-01']],
  ])('destroy --force kills a host that %s', async (_, args) => {
    const host = startProcess(...args);
    const directory = await seedHost(host);
    const kill = reapAsInitAfterKill(host);

    await destroySession('session-01', true);

    expect(kill).toHaveBeenCalledWith(host, 'SIGKILL');
    expect(await readManifest(manifestPath(directory))).toMatchObject({
      status: 'destroyed',
    });
  });

  it.skipIf(platform === 'win32')(
    'on darwin destroy --force kills a host that ps shows',
    async () => {
      const host = startProcess('_host', 'session-01', '1');
      const directory = await seedHost(host, 'none');
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const kill = reapAsInitAfterKill(host);

      await destroySession('session-01', true);

      expect(kill).toHaveBeenCalledWith(host, 'SIGKILL');
      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'destroyed',
      });
    },
  );

  it.skipIf(platform === 'win32')(
    'on darwin destroy --force does not kill a hostPid that runs another program',
    async () => {
      const other = startProcess();
      const directory = await seedHost(other, 'none');
      const record = await readManifest(manifestPath(directory));
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      await expect(destroySession('session-01', true)).rejects.toMatchObject({
        code: 'HOST_TIMEOUT',
      });
      expect(isRunning(other)).toBe(true);
      expect(await readManifest(manifestPath(directory))).toEqual(record);
    },
  );

  it.skipIf(platform === 'win32')(
    'on darwin reconcile records failed when no process has the pid that a linux host record names',
    async () => {
      const ended = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await once(ended, 'exit');
      const pid = ended.pid as number;
      expect(isRunning(pid)).toBe(false);
      const directory = await seedHost(pid, 'none');
      writeHostRecord(directory, {
        version: 1,
        pid,
        bootId: 'linux-boot',
        startTicks: '1',
        pidNamespace: 'pid:[1]',
        timeNamespace: null,
        machineId: null,
      });
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      await reconcileSession(directory);

      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'failed',
      });
    },
  );

  it.skipIf(platform === 'win32')(
    'on win32 destroy --force never kills the host',
    async () => {
      const host = startProcess('_host', 'session-01', '1');
      const directory = await seedHost(host, 'none');
      const record = await readManifest(manifestPath(directory));
      Object.defineProperty(process, 'platform', { value: 'win32' });

      await expect(destroySession('session-01', true)).rejects.toMatchObject({
        code: 'HOST_TIMEOUT',
      });
      expect(isRunning(host)).toBe(true);
      expect(await readManifest(manifestPath(directory))).toEqual(record);
    },
  );
});

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

  it.each(['ENOENT', 'EACCES'])(
    'on linux reads the caller as inside when /proc/self/stat fails with %s',
    async (code) => {
      await seedSession(makeRecord({ childPid: CHILD_PID }));
      Object.defineProperty(process, 'platform', { value: 'linux' });
      fsHooks.ownStatError = errno(code);

      expect(await cliRunsInsideProgramSession('session-01')).toBe(true);
    },
  );

  // In a PID namespace whose session leader runs outside it (`unshare -p -f`,
  // bwrap without --new-session), the kernel reports session id 0.
  it('on linux reads the caller as inside when /proc/self/stat shows session id 0', async () => {
    await seedSession(makeRecord({ childPid: CHILD_PID }));
    Object.defineProperty(process, 'platform', { value: 'linux' });
    fsHooks.ownStat = `${String(process.pid)} (node) S 1 ${String(process.pid)} 0 ${STAT_TAIL}`;

    expect(await cliRunsInsideProgramSession('session-01')).toBe(true);
  });

  it("on darwin matches the caller's process group only", async () => {
    const pgid = ownId('pgid');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    psHooks.tty = () => null;

    await expectMatchesOnly(pgid);
  });

  it("on darwin matches the caller's process group with no ps on PATH", async () => {
    const pgid = ownId('pgid');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    psHooks.tty = () => null;
    vi.stubEnv('PATH', '');

    await expectMatchesOnly(pgid);
  });

  it.each([
    ['ttys003', 'ttys003', true],
    ['pts/3', 'pts/3', true],
    ['ttypa', 'ttypa', true],
    ['ttyPz', 'ttyPz', true],
    ['ttys003', 'ttys004', false],
    ['ttypa', 'ttypb', false],
    ['??', '??', false],
    ['?', '?', false],
    ['-', '-', false],
    ['', '', false],
    ['console', 'console', false],
    ['ttys003', null, false],
  ] as const)(
    "on darwin, when ps shows the caller's terminal %s and the program's %s, matches: %s",
    async (own, program, matches) => {
      await seedSession(makeRecord({ childPid: CHILD_PID }));
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      psHooks.tty = (pid) =>
        pid === process.pid ? own : pid === CHILD_PID ? program : null;

      expect(await cliRunsInsideProgramSession('session-01')).toBe(matches);
    },
  );

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

describe('removeSocketDirectoryBestEffort', () => {
  afterEach(() => {
    fsHooks.rmdirError = undefined;
    vi.restoreAllMocks();
  });

  it('logs an unusual rmdir error instead of throwing it', async () => {
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    fsHooks.rmdirError = busy;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const socketFile = '/tmp/agent-tty/00000000/000000000000';

    await expect(removeSocketDirectoryIfEmpty(socketFile)).rejects.toBe(busy);
    await expect(
      removeSocketDirectoryBestEffort(socketFile),
    ).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(
      'could not remove the socket directory:',
      busy,
    );
  });
});

// A host of an older version listens at the old path under /tmp/agent-tty.
describe.skipIf(process.platform === 'win32')(
  'the old socket of a destroyed session',
  () => {
    let oldSocketFile = '';
    let server: Server | undefined;

    beforeEach(async () => {
      vi.stubEnv('AGENT_TTY_HOME', home);
      const old = legacySocketPath(socketPath(sessionDir(home, 'session-01')));
      expect(old).not.toBeNull();
      oldSocketFile = old as string;
      await mkdir(dirname(oldSocketFile), { recursive: true, mode: 0o700 });
      const listening = createServer();
      server = listening;
      await new Promise<void>((resolve) => {
        listening.listen(oldSocketFile, resolve);
      });
    });

    afterEach(async () => {
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
      await rm(dirname(oldSocketFile), { recursive: true, force: true });
    });

    it('a reconcile that repairs a marked session removes it', async () => {
      const directory = await seedSession(
        makeRecord({ status: 'failed', hostPid: null, childPid: null }),
      );
      writeFileSync(join(directory, 'destroyed'), '');

      await reconcileSession(directory);

      expect(await readManifest(manifestPath(directory))).toMatchObject({
        status: 'destroyed',
      });
      expect(existsSync(oldSocketFile)).toBe(false);
    });

    it('destroy removes it when the host is dead', async () => {
      await seedSession(makeRecord({ status: 'destroyed', childPid: null }));
      killProbeReportsDead();

      await expect(destroySession('session-01')).rejects.toMatchObject({
        code: 'SESSION_ALREADY_DESTROYED',
      });
      expect(existsSync(oldSocketFile)).toBe(false);
    });

    it('destroy keeps it when the host check throws', async () => {
      await seedSession(makeRecord({ status: 'destroyed', childPid: null }));
      const failure = Object.assign(new Error('kill EINVAL'), {
        code: 'EINVAL',
      });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw failure;
      });
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

      await expect(destroySession('session-01')).rejects.toMatchObject({
        code: 'SESSION_ALREADY_DESTROYED',
      });
      expect(existsSync(oldSocketFile)).toBe(true);
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('could not judge the host'),
        failure,
      );
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'destroy of a destroyed session',
  () => {
    let socketFile = '';

    beforeEach(async () => {
      vi.stubEnv('AGENT_TTY_HOME', home);
      socketFile = socketPath(sessionDir(home, 'session-01'));
      await ensureSocketRoot();
      await mkdir(dirname(socketFile), { recursive: true, mode: 0o700 });
      writeFileSync(socketFile, '');
    });

    afterEach(async () => {
      await rm(dirname(socketFile), { recursive: true, force: true });
    });

    it('removes the socket that a dead host left, then reports SESSION_ALREADY_DESTROYED', async () => {
      await seedSession(makeRecord({ status: 'destroyed', childPid: null }));
      killProbeReportsDead();

      await expect(destroySession('session-01')).rejects.toMatchObject({
        code: 'SESSION_ALREADY_DESTROYED',
      });
      expect(existsSync(socketFile)).toBe(false);
      expect(existsSync(dirname(socketFile))).toBe(false);
    });

    it('keeps the socket of a host that still runs', async () => {
      const directory = await seedSession(
        makeRecord({
          status: 'destroyed',
          hostPid: process.pid,
          childPid: null,
        }),
      );
      // Off Linux there is no host.json, and a host whose pid exists reads
      // as running.
      const own = captureHost(process.pid);
      expect(own !== null).toBe(process.platform === 'linux');
      if (own !== null) {
        writeHostRecord(directory, own);
      }

      await expect(destroySession('session-01')).rejects.toMatchObject({
        code: 'SESSION_ALREADY_DESTROYED',
      });
      expect(existsSync(socketFile)).toBe(true);
    });
  },
);
