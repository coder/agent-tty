import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  afterReadFile: undefined as ((path: string) => Promise<void>) | undefined,
}));

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

import type * as FsPromises from 'node:fs/promises';

import {
  allocateSession,
  destroySession,
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
  await rm(home, { recursive: true, force: true });
});

// gc's `rm` lands right after the nth read of the session's manifest.
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
