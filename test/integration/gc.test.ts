import { mkdtemp, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  crashSession,
  createSession,
  destroySession,
  inspectSession,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

interface GcResult {
  removedSessions: string[];
  skippedSessions: Array<{
    sessionId: string;
    reason: string;
  }>;
  dryRun: boolean;
  totalBytesFreed: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let testHome = '';

describe('gc integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    // prettier-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-gc-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('removes an exited session directory after destroy', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'echo ready; sleep 30',
    ]);
    const sessionDirectory = join(testHome, 'sessions', sessionId);

    const destroyResult = runCli(['destroy', sessionId, '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
    expect(destroyResult.stderr).toBe('');
    expect(await pathExists(sessionDirectory)).toBe(true);

    const gcResult = runCli(['gc', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(gcResult.status).toBe(0);
    expect(gcResult.stderr).toBe('');

    const gcEnvelope = JSON.parse(gcResult.stdout) as SuccessEnvelope<GcResult>;
    expect(gcEnvelope.ok).toBe(true);
    expect(gcEnvelope.command).toBe('gc');
    expect(gcEnvelope.result.removedSessions).toEqual([sessionId]);
    expect(gcEnvelope.result.skippedSessions).toEqual([]);
    expect(gcEnvelope.result.dryRun).toBe(false);
    expect(gcEnvelope.result.totalBytesFreed).toBeGreaterThan(0);
    expect(await pathExists(sessionDirectory)).toBe(false);
  });

  it('gc collects exited, failed, and destroyed sessions', async () => {
    const exitedId = createSession(testHome, ['/bin/sh', '-c', 'exit 0']);
    await sleep(2000);

    const failedId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
    crashSession(testHome, failedId);
    await sleep(500);

    const destroyedId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
    destroySession(testHome, destroyedId);

    const exitedSession = inspectSession(testHome, exitedId);
    expect(exitedSession.status).toBe('exited');

    const failedSession = inspectSession(testHome, failedId);
    expect(failedSession.status).toBe('failed');

    const destroyedSession = inspectSession(testHome, destroyedId);
    expect(destroyedSession.status).toBe('destroyed');

    const gcResult = runCli(['gc', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(gcResult.status).toBe(0);
    expect(gcResult.stderr).toBe('');

    const gcEnvelope = JSON.parse(gcResult.stdout) as SuccessEnvelope<GcResult>;
    expect(gcEnvelope.ok).toBe(true);
    expect(gcEnvelope.result.removedSessions).toHaveLength(3);
    expect(gcEnvelope.result.removedSessions).toContain(exitedId);
    expect(gcEnvelope.result.removedSessions).toContain(failedId);
    expect(gcEnvelope.result.removedSessions).toContain(destroyedId);
    expect(gcEnvelope.result.skippedSessions).toEqual([]);
  });
});
