import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  runCli,
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
    testHome = await mkdtemp(join(tmpdir(), 'agent-terminal-gc-'));
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
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
    expect(destroyResult.stderr).toBe('');
    expect(await pathExists(sessionDirectory)).toBe(true);

    const gcResult = runCli(['gc', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
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
});
