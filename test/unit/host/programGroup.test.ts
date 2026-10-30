import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureProgram,
  isProgramGroupAlive,
  judgeProgramGroup,
  parseAutogroup,
  parseProcStat,
  stopProgramGroup,
  writeProgramRecord,
  type ProcessRow,
  type ProgramRecord,
} from '../../../src/host/programGroup.js';
import {
  programRecordPath,
  sessionDir,
} from '../../../src/storage/sessionPaths.js';
import { capturesToken } from '../../helpers.js';

import type * as Fs from 'node:fs';

const procHooks = vi.hoisted(() => ({
  // /proc/<pid>/stat by pid, or the error that its read throws.
  stat: undefined as Map<string, string | Error> | undefined,
  mountinfo: undefined as string | undefined,
}));

const autogroupFile = vi.hoisted(() => ({
  read: null as ((path: string) => string | null) | null,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs');
  const readdirSync = ((path: string, ...rest: unknown[]) =>
    procHooks.stat !== undefined && path === '/proc'
      ? ['self', ...procHooks.stat.keys()]
      : (actual.readdirSync as (...args: unknown[]) => unknown)(
          path,
          ...rest,
        )) as typeof actual.readdirSync;
  const readFileSync = ((path: string, ...rest: unknown[]) => {
    const replaced = autogroupFile.read?.(path);
    if (replaced !== undefined && replaced !== null) {
      return replaced;
    }
    if (procHooks.stat !== undefined && path === '/proc/self/mountinfo') {
      if (procHooks.mountinfo === undefined) {
        throw errno('ENOENT');
      }
      return procHooks.mountinfo;
    }
    const pid = /^\/proc\/(\d+)\/stat$/.exec(path)?.[1];
    if (procHooks.stat === undefined || pid === undefined) {
      return (actual.readFileSync as (...args: unknown[]) => unknown)(
        path,
        ...rest,
      );
    }
    const stat = procHooks.stat.get(pid);
    if (stat instanceof Error) {
      throw stat;
    }
    return stat;
  }) as typeof actual.readFileSync;
  return { ...actual, readdirSync, readFileSync };
});

const platform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  procHooks.stat = undefined;
  procHooks.mountinfo = undefined;
  autogroupFile.read = null;
  Object.defineProperty(process, 'platform', { value: platform });
});

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function procMount(options: string): string {
  return `22 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc ${options}\n`;
}

function replaceAutogroupOf(pid: number, read: () => string): void {
  const path = `/proc/${String(pid)}/autogroup`;
  autogroupFile.read = (file) => (file === path ? read() : null);
}

function deniedRead(): never {
  throw Object.assign(new Error('EACCES: permission denied'), {
    code: 'EACCES',
  });
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function autogroupOf(pid: number | 'self'): number | null {
  return parseAutogroup(readFileSync(`/proc/${String(pid)}/autogroup`, 'utf8'));
}

describe('parseProcStat', () => {
  const tail =
    'S 4200 4242 4242 0 -1 4194560 494 0 0 0 0 0 0 0 20 0 1 0 347844922 18210816 1728';

  it.each(['sleep', 'a) (b', 'x y) S 1 2 3 (z'])(
    'reads the fields after the command name %j',
    (comm) => {
      expect(parseProcStat(`4242 (${comm}) ${tail}\n`)).toEqual({
        pid: 4242,
        state: 'S',
        ppid: 4200,
        pgid: 4242,
        sid: 4242,
        startTicks: '347844922',
      });
    },
  );
});

describe('parseAutogroup', () => {
  it.each([
    ['/autogroup-88327812 nice 0\n', 88327812],
    ['/autogroup-7 nice -5\n', 7],
    ['', null],
  ])('reads %j as %s', (text, id) => {
    expect(parseAutogroup(text)).toBe(id);
  });

  it.each(['autogroup?\n', '/autogroup-x nice 0\n', '/autogroup-7\n'])(
    'reads %j, which names no autogroup, as none',
    (text) => {
      expect(parseAutogroup(text)).toBeNull();
    },
  );
});

describe('captureProgram', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
  });

  it.runIf(capturesToken)(
    'records the boot id and the session autogroup of a child that leads its own session',
    () => {
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      children.push(child);
      const pid = child.pid as number;

      const record = captureProgram(pid);

      expect(record).toEqual({
        version: 1,
        pid,
        bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        autogroup: autogroupOf(pid),
      });
      expect(record.autogroup).not.toBe(autogroupOf('self'));
    },
  );

  it.runIf(capturesToken)(
    'records no token for a process that is not its child',
    () => {
      expect(captureProgram(process.ppid)).toEqual({
        version: 1,
        pid: process.ppid,
        bootId: null,
        autogroup: null,
      });
    },
  );

  it.runIf(capturesToken).each([
    ['names no autogroup', () => 'autogroup?\n'],
    ['cannot be read', deniedRead],
  ])('records no token when the autogroup of the child %s', (_name, read) => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    children.push(child);
    const pid = child.pid as number;
    replaceAutogroupOf(pid, read);

    expect(captureProgram(pid)).toEqual({
      version: 1,
      pid,
      bootId: null,
      autogroup: null,
    });
  });

  it.runIf(capturesToken).each(['EPERM', 'EACCES'])(
    'records no token when /proc refuses to show the child with %s',
    (readError) => {
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
      children.push(child);
      const pid = child.pid as number;
      procHooks.stat = new Map([[String(pid), errno(readError)]]);

      expect(captureProgram(pid)).toEqual({
        version: 1,
        pid,
        bootId: null,
        autogroup: null,
      });
    },
  );

  it.each(['EPERM', 'EACCES'])(
    'records no token when /proc refuses to show the boot id with %s',
    (readError) => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      autogroupFile.read = (file) => {
        if (file === '/proc/sys/kernel/random/boot_id') {
          throw errno(readError);
        }
        return file === '/proc/self/autogroup' ? '/autogroup-7 nice 0\n' : null;
      };

      expect(captureProgram(4242)).toEqual({
        version: 1,
        pid: 4242,
        bootId: null,
        autogroup: null,
      });
    },
  );

  it('records no token on a system without autogroups', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    expect(captureProgram(4242)).toEqual({
      version: 1,
      pid: 4242,
      bootId: null,
      autogroup: null,
    });
  });
});

describe('writeProgramRecord', () => {
  const record: ProgramRecord = {
    version: 1,
    pid: 4242,
    bootId: 'ce4b84e5-e77e-4d68-bc28-cd04a84f6cd7',
    autogroup: 7,
  };
  let home = '';

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-program-')));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes the record readable by its owner only', async () => {
    const directory = sessionDir(home, 'session-01');
    await mkdir(directory, { recursive: true });

    writeProgramRecord(directory, record);

    const path = programRecordPath(directory);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(record);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('fails and creates nothing when the session folder is gone', async () => {
    const directory = sessionDir(home, 'session-01');

    expect(thrownBy(() => writeProgramRecord(directory, record))).toMatchObject(
      { code: 'STORAGE_WRITE_ERROR' },
    );
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['half a token', { ...record, autogroup: null }],
    ['the group id 1', { ...record, pid: 1 }],
  ])('rejects a record with %s', async (_name, invalid) => {
    const directory = sessionDir(home, 'session-01');
    await mkdir(directory, { recursive: true });

    expect(
      thrownBy(() =>
        writeProgramRecord(directory, invalid as unknown as ProgramRecord),
      ),
    ).toMatchObject({ code: 'MANIFEST_VALIDATION_ERROR' });
  });
});

describe('judgeProgramGroup', () => {
  const BOOT = 'ce4b84e5-e77e-4d68-bc28-cd04a84f6cd7';
  const record = { version: 1, pid: 4242, bootId: BOOT, autogroup: 7 } as const;

  function member(pid: number, overrides: Partial<ProcessRow> = {}) {
    return {
      pid,
      pgid: 4242,
      sid: 4242,
      state: 'S',
      autogroup: 7,
      ...overrides,
    };
  }

  it.each<[string, string | null, ProcessRow[], string]>([
    ['a live leader', BOOT, [member(4242)], 'owned'],
    ['a member left by an exited leader', BOOT, [member(4250)], 'owned'],
    [
      'members born after the leader exited',
      BOOT,
      [member(4300, { state: 'R' }), member(4301)],
      'owned',
    ],
    ['no process', BOOT, [], 'gone'],
    [
      'processes of other groups only',
      BOOT,
      [member(100, { pgid: 100, sid: 100, autogroup: 9 })],
      'gone',
    ],
    [
      'zombies only',
      BOOT,
      [member(4242, { state: 'Z' }), member(4250, { state: 'X' })],
      'gone',
    ],
    [
      'a recycled group with another autogroup',
      BOOT,
      [member(4242, { autogroup: 8 })],
      'unproven',
    ],
    [
      'a zombie with the token and a member without it',
      BOOT,
      [member(4242, { state: 'Z' }), member(4250, { autogroup: 8 })],
      'unproven',
    ],
    [
      'a member of another session',
      BOOT,
      [member(4250, { sid: 4000 })],
      'unproven',
    ],
    [
      'a member of another session whose autogroup cannot be read',
      BOOT,
      [member(4250, { sid: 4000, autogroup: null })],
      'unproven',
    ],
    ['another boot', 'other-boot', [member(4242)], 'unproven'],
    [
      'another boot with a member whose autogroup cannot be read',
      'other-boot',
      [member(4242, { autogroup: null })],
      'unproven',
    ],
    ['an unreadable boot id', null, [member(4242)], 'unknown'],
    [
      'zombies only with an unreadable boot id',
      null,
      [member(4242, { state: 'Z' })],
      'gone',
    ],
    [
      'a leader whose autogroup cannot be read',
      BOOT,
      [member(4242, { autogroup: null })],
      'unknown',
    ],
    [
      'a member left by an exited leader whose autogroup cannot be read',
      BOOT,
      [member(4250, { autogroup: null })],
      'unknown',
    ],
    [
      'a member with the token beside one whose autogroup cannot be read',
      BOOT,
      [member(4242, { autogroup: null }), member(4250)],
      'owned',
    ],
  ])('judges %s', (_name, bootId, rows, verdict) => {
    expect(judgeProgramGroup(record, bootId, rows).verdict).toBe(verdict);
  });
});

const CHILD_PID = 2_147_483_645;

function killFailsWith(code: string) {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    throw errno(code);
  });
}

function probeEnds(outcome: 'ok' | 'EPERM') {
  return outcome === 'ok'
    ? vi.spyOn(process, 'kill').mockReturnValue(true)
    : killFailsWith(outcome);
}

// /proc shows one process of the group per state, under a command name with
// spaces and parentheses, beside a process of another group and a process
// that ends during the scan. Each process of the group leads it and its
// session. Unless the test set its own, /proc is mounted without hidepid,
// so the result does not depend on the host.
function procShowsGroup(...states: string[]): void {
  procHooks.mountinfo ??= procMount('rw');
  const tail = '0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 100';
  procHooks.stat = new Map<string, string | Error>([
    ['1', `1 (init) S 0 1 1 ${tail}`],
    ['2', errno('ESRCH')],
  ]);
  states.forEach((state, index) => {
    const pid = String(100 + index);
    procHooks.stat?.set(
      pid,
      `${pid} (a) b (c) ${state} 1 ${String(CHILD_PID)} ${String(CHILD_PID)} ${tail}`,
    );
  });
}

describe('a program group without a token', () => {
  const group: ProgramRecord = {
    version: 1,
    pid: CHILD_PID,
    bootId: null,
    autogroup: null,
  };

  it.each([
    ['ok', ['Z', 'X'], false],
    ['ok', ['Z', 'S'], true],
    ['ok', [], false],
    ['EPERM', ['Z'], false],
    ['EPERM', ['R'], true],
    ['EPERM', [], true],
  ] as const)(
    'on linux, when the probe ends %s and the group shows %j, is alive: %s',
    (outcome, states, alive) => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      procShowsGroup(...states);
      probeEnds(outcome);

      expect(isProgramGroupAlive(group)).toBe(alive);
    },
  );

  it.each(['ok', 'EPERM'] as const)(
    'on darwin, when the probe ends %s, counts a zombie as alive',
    (outcome) => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      procShowsGroup('Z');
      probeEnds(outcome);

      expect(isProgramGroupAlive(group)).toBe(true);
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
      procHooks.stat?.set('3', errno(readError));
      probeEnds(outcome);

      expect(isProgramGroupAlive(group)).toBe(true);
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
      procHooks.mountinfo = procMount(`rw,${option}`);
      procShowsGroup('Z');
      probeEnds('ok');

      expect(isProgramGroupAlive(group)).toBe(true);
    },
  );

  it('on linux, when a hidepid /proc is mounted over a plain one, counts a zombie group alive', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    procHooks.mountinfo =
      procMount('rw') +
      procMount('rw,hidepid=invisible').replace('22 1 ', '23 22 ');
    procShowsGroup('Z');
    probeEnds('ok');

    expect(isProgramGroupAlive(group)).toBe(true);
  });

  it('on linux, when mountinfo cannot be read, counts a zombie group alive', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    procShowsGroup('Z');
    procHooks.mountinfo = undefined;
    probeEnds('ok');

    expect(isProgramGroupAlive(group)).toBe(true);
  });

  it('is not alive when the probe fails with ESRCH', () => {
    procShowsGroup('S');
    killFailsWith('ESRCH');

    expect(isProgramGroupAlive(group)).toBe(false);
  });

  it.each([
    ['linux', -CHILD_PID],
    ['darwin', -CHILD_PID],
    ['win32', CHILD_PID],
  ])('on %s gets the kill %i', (name, target) => {
    Object.defineProperty(process, 'platform', { value: name });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    stopProgramGroup(group);

    expect(kill).toHaveBeenCalledExactlyOnceWith(target, 'SIGKILL');
  });

  it.each(['EPERM', 'ESRCH'])('ignores a kill that fails with %s', (code) => {
    killFailsWith(code);

    expect(() => {
      stopProgramGroup(group);
    }).not.toThrow();
  });

  it.each([0, 1])('refuses the group id %i', (pgid) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(() => {
      stopProgramGroup({ ...group, pid: pgid });
    }).toThrow('process group id must be an integer above 1');
    expect(kill).not.toHaveBeenCalled();
  });

  it('is no group when nothing names one', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    stopProgramGroup(null);

    expect(isProgramGroupAlive(null)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('a program group with a token, as a faked /proc shows it', () => {
  const BOOT = 'ce4b84e5-e77e-4d68-bc28-cd04a84f6cd7';
  const group: ProgramRecord = {
    version: 1,
    pid: CHILD_PID,
    bootId: BOOT,
    autogroup: 7,
  };

  // Every process in view carries the token.
  function procShowsTokenGroup(...states: string[]): void {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    procShowsGroup(...states);
    autogroupFile.read = (file) =>
      file === '/proc/sys/kernel/random/boot_id'
        ? `${BOOT}\n`
        : /^\/proc\/\d+\/autogroup$/.test(file)
          ? '/autogroup-7 nice 0\n'
          : null;
  }

  it.each(['EPERM', 'EACCES'])(
    'is alive and gets the kill when a live member carries the token and another process refuses its read with %s',
    (readError) => {
      procShowsTokenGroup('Z', 'S');
      procHooks.stat?.set('3', errno(readError));
      const kill = probeEnds('ok');

      expect(isProgramGroupAlive(group)).toBe(true);
      stopProgramGroup(group);
      expect(kill).toHaveBeenCalledWith(-CHILD_PID, 'SIGKILL');
    },
  );

  it.each(['EPERM', 'EACCES'])(
    'is alive with only a zombie in view while another process refuses its read with %s',
    (readError) => {
      procShowsTokenGroup('Z');
      procHooks.stat?.set('3', errno(readError));
      probeEnds('ok');

      expect(isProgramGroupAlive(group)).toBe(true);
    },
  );

  it.each([
    'hidepid=2',
    'hidepid=invisible',
    'hidepid=4',
    'hidepid=ptraceable',
  ])(
    'is alive with only a zombie in view when /proc is mounted with %s',
    (option) => {
      procShowsTokenGroup('Z');
      procHooks.mountinfo = procMount(`rw,${option}`);
      const kill = probeEnds('ok');

      expect(isProgramGroupAlive(group)).toBe(true);
      stopProgramGroup(group);
      expect(kill).not.toHaveBeenCalledWith(-CHILD_PID, 'SIGKILL');
    },
  );

  it.each([
    ['refuses its read', deniedRead],
    ['is empty', () => ''],
  ])(
    'is alive and gets no kill while the autogroup of a live member %s',
    (_name, read) => {
      procShowsTokenGroup('S');
      const tokenRead = autogroupFile.read;
      autogroupFile.read = (file) =>
        file === '/proc/100/autogroup' ? read() : (tokenRead?.(file) ?? null);
      const kill = probeEnds('ok');

      expect(isProgramGroupAlive(group)).toBe(true);
      stopProgramGroup(group);
      expect(kill).not.toHaveBeenCalledWith(-CHILD_PID, 'SIGKILL');
    },
  );

  it('is alive and gets no kill while /proc refuses to show the boot id', () => {
    procShowsTokenGroup('S');
    const tokenRead = autogroupFile.read;
    autogroupFile.read = (file) =>
      file === '/proc/sys/kernel/random/boot_id'
        ? deniedRead()
        : (tokenRead?.(file) ?? null);
    const kill = probeEnds('ok');

    expect(isProgramGroupAlive(group)).toBe(true);
    stopProgramGroup(group);
    expect(kill).not.toHaveBeenCalledWith(-CHILD_PID, 'SIGKILL');
  });

  it('is not alive and gets no kill while a live member names another autogroup', () => {
    procShowsTokenGroup('S');
    const tokenRead = autogroupFile.read;
    autogroupFile.read = (file) =>
      file === '/proc/100/autogroup'
        ? '/autogroup-8 nice 0\n'
        : (tokenRead?.(file) ?? null);
    const kill = probeEnds('ok');

    expect(isProgramGroupAlive(group)).toBe(false);
    stopProgramGroup(group);
    expect(kill).not.toHaveBeenCalledWith(-CHILD_PID, 'SIGKILL');
  });

  it('is alive with no member in view when /proc hides other users and the probe ends EPERM', () => {
    procShowsTokenGroup();
    procHooks.mountinfo = procMount('rw,hidepid=2');
    probeEnds('EPERM');

    expect(isProgramGroupAlive(group)).toBe(true);
  });

  it('is not alive with only zombies in view when /proc shows every process', () => {
    procShowsTokenGroup('Z', 'X');
    probeEnds('ok');

    expect(isProgramGroupAlive(group)).toBe(false);
  });

  it('is not alive when /proc hides other users and the probe finds no process', () => {
    procShowsTokenGroup();
    procHooks.mountinfo = procMount('rw,hidepid=2');
    killFailsWith('ESRCH');

    expect(isProgramGroupAlive(group)).toBe(false);
  });
});

describe.runIf(capturesToken)('a program group with a token', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
  });

  function startGroup(): { pid: number; record: ProgramRecord } {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    children.push(child);
    const pid = child.pid as number;
    const record = captureProgram(pid);
    expect(record.autogroup).not.toBeNull();
    return { pid, record };
  }

  it('gets the kill when the record proves it', async () => {
    const { pid, record } = startGroup();
    const kill = vi.spyOn(process, 'kill');

    expect(isProgramGroupAlive(record)).toBe(true);
    stopProgramGroup(record);

    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    // SIGKILL ends the process soon after kill(2) returns, not at once.
    await vi.waitFor(() => {
      expect(isProgramGroupAlive(record)).toBe(false);
    });
  });

  it('gets no kill when the record names another autogroup', () => {
    const { pid, record } = startGroup();
    const mismatched =
      record.autogroup === null
        ? record
        : { ...record, autogroup: record.autogroup + 1 };
    const kill = vi.spyOn(process, 'kill');

    stopProgramGroup(mismatched);

    expect(kill).not.toHaveBeenCalled();
    expect(isProgramGroupAlive(mismatched)).toBe(false);
    expect(() => process.kill(-pid, 0)).not.toThrow();
  });

  it.each([
    ['names no autogroup', () => 'autogroup?\n'],
    ['cannot be read', deniedRead],
  ])(
    'gets no kill and reads alive when the autogroup of its member %s',
    (_name, read) => {
      const { pid, record } = startGroup();
      replaceAutogroupOf(pid, read);
      const kill = vi.spyOn(process, 'kill');

      stopProgramGroup(record);

      expect(kill).not.toHaveBeenCalled();
      expect(isProgramGroupAlive(record)).toBe(true);
      expect(() => process.kill(-pid, 0)).not.toThrow();
    },
  );

  it('gets no kill once the group is gone', async () => {
    const { record } = startGroup();
    const child = children.pop() as ChildProcess;
    child.kill('SIGKILL');
    await once(child, 'exit');
    const kill = vi.spyOn(process, 'kill');

    stopProgramGroup(record);

    expect(kill).not.toHaveBeenCalled();
    expect(isProgramGroupAlive(record)).toBe(false);
  });
});
