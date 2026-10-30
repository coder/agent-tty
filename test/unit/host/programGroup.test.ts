import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  captureProgram,
  parseAutogroup,
  parseProcStat,
  writeProgramRecord,
  type ProgramRecord,
} from '../../../src/host/programGroup.js';
import {
  programRecordPath,
  sessionDir,
} from '../../../src/storage/sessionPaths.js';

const platform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
});

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
});

describe('captureProgram', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
  });

  // Only Linux has autogroups.
  it.runIf(platform === 'linux')(
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

  it.runIf(platform === 'linux')(
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
