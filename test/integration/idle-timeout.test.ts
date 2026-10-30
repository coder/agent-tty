import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  groupEnds,
  inspectSession,
  isGroupAlive,
  killGroupIfAlive,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

let testHome = '';

// The preload makes every group signal fail with EPERM and deliver nothing,
// as when the group's remaining processes belong to another user.
const refusesGroupKill = {
  NODE_OPTIONS: [
    process.env.NODE_OPTIONS ?? '',
    `--import=${pathToFileURL(resolve('test/fixtures/eperm-group-kill.ts')).href}`,
  ].join(' '),
};

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

  it('kills the process group of a program that ignores the idle hang-up', async () => {
    const createResult = runCli(
      [
        'create',
        '--idle-timeout-ms',
        '300',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'trap "" HUP; while :; do sleep 1; done',
      ],
      { AGENT_TTY_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    const deadline = Date.now() + 10_000;
    let session = inspectSession(testHome, sessionId);
    while (session.status === 'running' && Date.now() < deadline) {
      await sleep(200);
      session = inspectSession(testHome, sessionId);
    }

    expect(session.status).toBe('exited');
    expect(session.childPid).toBeTypeOf('number');
    expect(await groupEnds(session.childPid as number)).toBe(true);
  });

  it('kills a background process that ignores the idle hang-up after the program exits on it', async () => {
    const createResult = runCli(
      [
        'create',
        '--idle-timeout-ms',
        '300',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        '(trap "" HUP; exec sleep 300) & wait',
      ],
      { AGENT_TTY_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    const deadline = Date.now() + 10_000;
    let session = inspectSession(testHome, sessionId);
    while (session.status === 'running' && Date.now() < deadline) {
      await sleep(200);
      session = inspectSession(testHome, sessionId);
    }

    expect(session.status).toBe('exited');
    expect(session.childPid).toBeTypeOf('number');
    expect(await groupEnds(session.childPid as number)).toBe(true);
  });

  // Only Linux records the token that lets destroy stop what an exited
  // program left.
  it.runIf(process.platform === 'linux')(
    'leaves a member that refuses the kill to a destroy that times out',
    async () => {
      const createResult = runCli(
        [
          'create',
          '--idle-timeout-ms',
          '300',
          '--json',
          '--',
          '/bin/sh',
          '-c',
          '(trap "" HUP; exec sleep 300) & wait',
        ],
        { ...refusesGroupKill, AGENT_TTY_HOME: testHome },
      );
      expect(createResult.status).toBe(0);
      const sessionId = (
        JSON.parse(createResult.stdout) as SuccessEnvelope<{
          sessionId: string;
        }>
      ).result.sessionId;

      let session = inspectSession(testHome, sessionId);
      const pgid = session.childPid;
      if (pgid === null || pgid <= 1) {
        throw new Error(`the session names no program group: ${String(pgid)}`);
      }
      try {
        const deadline = Date.now() + 10_000;
        while (session.status === 'running' && Date.now() < deadline) {
          await sleep(200);
          session = inspectSession(testHome, sessionId);
        }
        expect(session.status).toBe('exited');
        expect(isGroupAlive(pgid)).toBe(true);

        const destroyResult = runCli(['destroy', sessionId, '--json'], {
          ...refusesGroupKill,
          AGENT_TTY_HOME: testHome,
        });
        expect(JSON.parse(destroyResult.stdout)).toMatchObject({
          ok: false,
          error: { code: 'HOST_TIMEOUT' },
        });
        expect(destroyResult.status).toBe(5);
        expect(inspectSession(testHome, sessionId).status).toBe('exited');
        expect(isGroupAlive(pgid)).toBe(true);
      } finally {
        killGroupIfAlive(pgid);
      }
    },
  );
});
