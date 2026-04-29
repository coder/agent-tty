import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCommandTarget } from '../../../src/cli/commandTarget.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import { createTestSessionRecord } from '../../helpers.js';
import type {
  SessionRecord,
  SessionStatus,
} from '../../../src/protocol/schemas.js';
import { writeManifest } from '../../../src/storage/manifests.js';
import {
  manifestPath,
  sessionDir,
  socketPath,
} from '../../../src/storage/sessionPaths.js';

let testHome = '';

async function createHome(): Promise<string> {
  testHome = await mkdtemp(join(tmpdir(), 'agent-tty-command-target-'));
  return testHome;
}

afterEach(async () => {
  if (testHome.length > 0) {
    await rm(testHome, { recursive: true, force: true });
  }
  testHome = '';
});

async function writeSessionManifest(
  home: string,
  sessionId: string,
  status: SessionStatus,
): Promise<SessionRecord> {
  const manifest = createTestSessionRecord({
    sessionId,
    status,
    hostPid: status === 'running' ? 123 : null,
    childPid: status === 'running' ? 456 : null,
    exitCode: status === 'exited' ? 0 : null,
  });
  await writeManifest(manifestPath(sessionDir(home, sessionId)), manifest);
  return manifest;
}

describe('resolveCommandTarget', () => {
  it('throws SESSION_NOT_FOUND when the session manifest is missing', async () => {
    const home = await createHome();

    await expect(
      resolveCommandTarget({ home, sessionId: 'missing-session' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_FOUND,
      message: 'Session "missing-session" was not found.',
      details: {
        sessionId: 'missing-session',
        manifestPath: join(home, 'sessions', 'missing-session', 'session.json'),
      },
    });
  });

  it('throws SESSION_NOT_RUNNING when the session is not commandable', async () => {
    const home = await createHome();
    await writeSessionManifest(home, 'exited-session', 'exited');

    await expect(
      resolveCommandTarget({ home, sessionId: 'exited-session' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_RUNNING,
      message: 'Session "exited-session" is not running.',
      details: {
        sessionId: 'exited-session',
        status: 'exited',
      },
    });
  });

  it('throws SESSION_ALREADY_DESTROYED when the session is destroyed', async () => {
    const home = await createHome();
    await writeSessionManifest(home, 'destroyed-session', 'destroyed');

    await expect(
      resolveCommandTarget({ home, sessionId: 'destroyed-session' }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_ALREADY_DESTROYED,
      message: 'Session "destroyed-session" is already destroyed.',
      details: {
        sessionId: 'destroyed-session',
        status: 'destroyed',
      },
    });
  });

  it('returns the resolved command target for a running session', async () => {
    const home = await createHome();
    const manifest = await writeSessionManifest(
      home,
      'running-session',
      'running',
    );
    const sessionDirectory = sessionDir(home, 'running-session');

    await expect(
      resolveCommandTarget({ home, sessionId: 'running-session' }),
    ).resolves.toEqual({
      sessionId: 'running-session',
      sessionDirectory,
      manifestPath: manifestPath(sessionDirectory),
      socketPath: socketPath(sessionDirectory),
      manifest,
    });
  });
});
