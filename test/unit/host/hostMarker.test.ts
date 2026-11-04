import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { runHost } from '../../../src/host/hostMain.js';
import type * as ProgramGroupModule from '../../../src/host/programGroup.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';
import {
  readManifest,
  writeCreateFailedMarker,
  writeManifest,
} from '../../../src/storage/manifests.js';
import {
  createFailedMarkerPath,
  manifestPath,
  programRecordPath,
  sessionDir,
  socketPath,
} from '../../../src/storage/sessionPaths.js';
import { isGroupAlive, killGroupIfAlive } from '../../helpers.js';

// Runs after the host's start-up write of program.json, where a create that
// gives up can write its marker.
const hooks = vi.hoisted(() => ({ afterProgramRecord: (): void => {} }));

vi.mock('../../../src/host/programGroup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProgramGroupModule>();
  return {
    ...actual,
    writeProgramRecord: (
      ...args: Parameters<typeof actual.writeProgramRecord>
    ): void => {
      actual.writeProgramRecord(...args);
      hooks.afterProgramRecord();
    },
  };
});

const SESSION_ID = 'session-01';

let home = '';
let directory = '';
let sigtermListeners: ReadonlySet<unknown> = new Set();

function readProgramGroup(): number {
  const { pid } = JSON.parse(
    readFileSync(programRecordPath(directory), 'utf8'),
  ) as { pid: number };
  expect(pid).toBeGreaterThan(1);
  return pid;
}

// The host records destroyed, its program's group is gone and its socket is
// removed.
async function expectHostStopped(group: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let manifest = await readManifest(manifestPath(directory));
  while (
    manifest.status !== 'destroyed' ||
    isGroupAlive(group) ||
    existsSync(socketPath(directory))
  ) {
    expect(Date.now()).toBeLessThan(deadline);
    await delay(50);
    manifest = await readManifest(manifestPath(directory));
  }
}

// Spies on the timers before runHost starts. The returned function waits
// until the host's marker watch, its only 100 ms interval, has stopped. A
// stopped watch never checks for the marker again.
function trackMarkerWatch(): () => Promise<void> {
  const setSpy = vi.spyOn(globalThis, 'setInterval');
  const clearSpy = vi.spyOn(globalThis, 'clearInterval');
  return async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const watches = setSpy.mock.calls.flatMap((call, index) =>
        call[1] === 100 ? [setSpy.mock.results[index]?.value as unknown] : [],
      );
      expect(watches).toHaveLength(1);
      if (clearSpy.mock.calls.some(([timer]) => timer === watches[0])) {
        return;
      }
      expect(Date.now()).toBeLessThan(deadline);
      await delay(20);
    }
  };
}

// Stops the host as a SIGTERM would.
function sendSigterm(): void {
  for (const listener of process.rawListeners('SIGTERM')) {
    if (!sigtermListeners.has(listener)) {
      (listener as () => void)();
    }
  }
}

beforeEach(async () => {
  // The host resolves its Home to the real path, and the socket path is
  // derived from that path, as on macOS, where tmpdir() is a symlink.
  home = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-tty-host-marker-')),
  );
  vi.stubEnv('AGENT_TTY_HOME', home);
  directory = sessionDir(home, SESSION_ID);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record: SessionRecord = {
    version: 1,
    sessionId: SESSION_ID,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    status: 'running',
    command: ['/bin/sh', '-c', 'exec sleep 30'],
    cwd: home,
    cols: 80,
    rows: 24,
    hostPid: process.pid,
    childPid: null,
    exitCode: null,
    exitSignal: null,
  };
  await writeManifest(manifestPath(directory), record);
  sigtermListeners = new Set(process.rawListeners('SIGTERM'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  hooks.afterProgramRecord = () => {};
  // runHost adds a SIGTERM listener that would outlive the test.
  for (const listener of process.rawListeners('SIGTERM')) {
    if (!sigtermListeners.has(listener)) {
      process.removeListener('SIGTERM', listener);
    }
  }
  if (existsSync(programRecordPath(directory))) {
    killGroupIfAlive(readProgramGroup());
  }
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('runHost and the create-failed marker', () => {
  it('spawns no program when the marker exists before the spawn', async () => {
    await writeCreateFailedMarker(
      createFailedMarkerPath(directory),
      SESSION_ID,
    );

    await runHost(SESSION_ID, process.pid);

    expect(existsSync(programRecordPath(directory))).toBe(false);
    const manifest = await readManifest(manifestPath(directory));
    expect(manifest.status).toBe('running');
    expect(manifest.childPid).toBeNull();
  });

  it('stops its program and never listens when the marker appears during the start-up write', async () => {
    hooks.afterProgramRecord = () => {
      writeFileSync(createFailedMarkerPath(directory), '');
    };

    await runHost(SESSION_ID, process.pid);

    expect(existsSync(socketPath(directory))).toBe(false);
    await expectHostStopped(readProgramGroup());
  });

  it('stops a serving host when the marker appears while its creator runs', async () => {
    await runHost(SESSION_ID, process.pid);
    expect(existsSync(socketPath(directory))).toBe(true);

    await writeCreateFailedMarker(
      createFailedMarkerPath(directory),
      SESSION_ID,
    );

    await expectHostStopped(readProgramGroup());
  });

  it('keeps serving when the marker appears after its creator has exited', async () => {
    const creator = spawn('sleep', ['30'], { stdio: 'ignore' });
    expect(creator.pid).toBeGreaterThan(0);
    const watchStopped = trackMarkerWatch();
    await runHost(SESSION_ID, creator.pid as number);
    expect(existsSync(socketPath(directory))).toBe(true);
    creator.kill('SIGKILL');
    await once(creator, 'exit');
    await watchStopped();

    await writeCreateFailedMarker(
      createFailedMarkerPath(directory),
      SESSION_ID,
    );

    expect((await readManifest(manifestPath(directory))).status).toBe(
      'running',
    );
    expect(existsSync(socketPath(directory))).toBe(true);
    sendSigterm();
    await expectHostStopped(readProgramGroup());
  }, 15_000);

  it('keeps serving when a process of another user takes the pid of its creator', async () => {
    const creator = spawn('sleep', ['30'], { stdio: 'ignore' });
    onTestFinished(() => {
      creator.kill('SIGKILL');
    });
    const creatorPid = creator.pid as number;
    expect(creatorPid).toBeGreaterThan(0);
    const watchStopped = trackMarkerWatch();
    await runHost(SESSION_ID, creatorPid);
    expect(existsSync(socketPath(directory))).toBe(true);
    // From here on, the probe of the creator's pid answers EPERM.
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === creatorPid && signal === 0) {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    });
    await watchStopped();

    await writeCreateFailedMarker(
      createFailedMarkerPath(directory),
      SESSION_ID,
    );

    expect((await readManifest(manifestPath(directory))).status).toBe(
      'running',
    );
    expect(existsSync(socketPath(directory))).toBe(true);
    vi.restoreAllMocks();
    sendSigterm();
    await expectHostStopped(readProgramGroup());
  }, 15_000);
});
