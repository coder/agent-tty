import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  inspectSession,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

let testHome = '';

describe('idle-timeout integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('auto-exits an idle session once the idle timeout elapses', async () => {
    // `exec cat` blocks on stdin and produces no further output, so the session
    // is idle from creation. The idle poller's cadence is
    // min(idleTimeoutMs, IDLE_CHECK_CAP_MS=5000), so a small timeout makes the
    // first poll fire quickly, kill the PTY, and reconcile the session to
    // `exited` without any further input.
    const idleTimeoutMs = 300;
    const createResult = runCli(
      [
        'create',
        '--idle-timeout-ms',
        String(idleTimeoutMs),
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'exec cat',
      ],
      { AGENT_TTY_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    // Poll inspect until the session reaches a terminal status, with a generous
    // deadline that comfortably exceeds the poll cadence and reconciliation.
    const deadline = Date.now() + 20_000;
    let status = inspectSession(testHome, sessionId).status;
    while (
      status !== 'exited' &&
      status !== 'failed' &&
      Date.now() < deadline
    ) {
      await sleep(200);
      status = inspectSession(testHome, sessionId).status;
    }

    expect(status).toBe('exited');
  });
});
