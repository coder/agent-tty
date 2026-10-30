import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allocateSession,
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
  await rm(home, { recursive: true, force: true });
});

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

  it.each([0, 1])('refuses the group id %i', (pgid) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(() => killProcessGroupBestEffort(pgid)).toThrow(
      'process group id must be an integer above 1',
    );
    expect(kill).not.toHaveBeenCalled();
  });
});
