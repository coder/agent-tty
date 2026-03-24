import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  inspectSession,
  readEvents,
  runCli,
  sleep,
  type SuccessEnvelope,
  type WaitResult,
} from '../helpers.js';

let testHome = '';

describe('io-loop integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'agent-terminal-home-'));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('type + send-keys Enter + wait --idle-ms produces output', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec /bin/sh']);
      await sleep(500);

      const typeResult = runCli(
        ['type', sessionId, 'echo test-marker', '--json'],
        {
          AGENT_TERMINAL_HOME: testHome,
        },
      );
      expect(typeResult.status).toBe(0);
      expect(typeResult.stderr).toBe('');

      const sendKeysResult = runCli(
        ['send-keys', sessionId, 'Enter', '--json'],
        {
          AGENT_TERMINAL_HOME: testHome,
        },
      );
      expect(sendKeysResult.status).toBe(0);
      expect(sendKeysResult.stderr).toBe('');

      const waitResult = runCli(
        ['wait', sessionId, '--idle-ms', '500', '--timeout', '5000', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const envelope = JSON.parse(
        waitResult.stdout,
      ) as SuccessEnvelope<WaitResult>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result.timedOut).toBe(false);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const allOutput = events
        .filter((event) => event.type === 'output')
        .map((event) => {
          const data = event.payload.data;
          return typeof data === 'string' ? data : '';
        })
        .join('');
      expect(allOutput).toContain('test-marker');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('wait --idle-ms measures idle from call time, not host startup', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
      await sleep(2000);

      const start = Date.now();
      const waitResult = runCli(
        ['wait', sessionId, '--idle-ms', '1000', '--timeout', '5000', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      const elapsed = Date.now() - start;

      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const envelope = JSON.parse(
        waitResult.stdout,
      ) as SuccessEnvelope<WaitResult>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result.timedOut).toBe(false);
      expect(elapsed).toBeGreaterThan(800);
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('wait --idle-ms times out when timeout expires first', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
      await sleep(500);

      const typeResult = runCli(['type', sessionId, 'keepalive', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(typeResult.status).toBe(0);
      expect(typeResult.stderr).toBe('');

      const sendKeysResult = runCli(
        ['send-keys', sessionId, 'Enter', '--json'],
        {
          AGENT_TERMINAL_HOME: testHome,
        },
      );
      expect(sendKeysResult.status).toBe(0);
      expect(sendKeysResult.stderr).toBe('');

      const waitResult = runCli(
        ['wait', sessionId, '--idle-ms', '60000', '--timeout', '300', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');

      const envelope = JSON.parse(
        waitResult.stdout,
      ) as SuccessEnvelope<WaitResult>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result.timedOut).toBe(true);
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('session idle timeout exits an otherwise idle session', async () => {
    let sessionId = '';

    try {
      const createResult = runCli(
        [
          'create',
          '--idle-timeout-ms',
          '2000',
          '--json',
          '--',
          '/bin/sh',
          '-c',
          'exec cat',
        ],
        { AGENT_TERMINAL_HOME: testHome },
      );
      expect(createResult.status).toBe(0);
      expect(createResult.stderr).toBe('');
      sessionId = (
        JSON.parse(createResult.stdout) as SuccessEnvelope<{
          sessionId: string;
        }>
      ).result.sessionId;

      const waitResult = runCli(
        ['wait', sessionId, '--exit', '--timeout', '10000', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const waitEnvelope = JSON.parse(
        waitResult.stdout,
      ) as SuccessEnvelope<WaitResult>;
      expect(waitEnvelope.ok).toBe(true);
      expect(waitEnvelope.result.timedOut).toBe(false);

      await sleep(1000);

      const session = inspectSession(testHome, sessionId);
      expect(session.status).toBe('exited');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('session with idle-timeout-ms 0 does not exit on idle', async () => {
    let sessionId = '';

    try {
      const createResult = runCli(
        [
          'create',
          '--idle-timeout-ms',
          '0',
          '--json',
          '--',
          '/bin/sh',
          '-c',
          'exec cat',
        ],
        { AGENT_TERMINAL_HOME: testHome },
      );
      expect(createResult.status).toBe(0);
      expect(createResult.stderr).toBe('');
      sessionId = (
        JSON.parse(createResult.stdout) as SuccessEnvelope<{
          sessionId: string;
        }>
      ).result.sessionId;

      await sleep(3000);

      const session = inspectSession(testHome, sessionId);
      expect(session.status).toBe('running');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('signal SIGTERM terminates session', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const signalResult = runCli(['signal', sessionId, 'SIGTERM', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(signalResult.status).toBe(0);
      expect(signalResult.stderr).toBe('');
      const signalEnvelope = JSON.parse(
        signalResult.stdout,
      ) as SuccessEnvelope<{
        signal: string;
        delivered: boolean;
      }>;
      expect(signalEnvelope.ok).toBe(true);
      expect(signalEnvelope.result).toEqual({
        signal: 'SIGTERM',
        delivered: true,
      });

      const waitResult = runCli(
        ['wait', sessionId, '--exit', '--timeout', '5000', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const waitEnvelope = JSON.parse(
        waitResult.stdout,
      ) as SuccessEnvelope<WaitResult>;
      expect(waitEnvelope.ok).toBe(true);
      expect(waitEnvelope.result.timedOut).toBe(false);

      await sleep(300);

      const session = inspectSession(testHome, sessionId);
      expect(session.status).toBe('exited');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('wait --exit returns exit code for a short-lived command', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome, ['/bin/sh', '-c', 'exit 42']);
      await sleep(700);

      const waitResult = runCli(
        ['wait', sessionId, '--exit', '--timeout', '5000', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const envelope = JSON.parse(
        waitResult.stdout,
      ) as SuccessEnvelope<WaitResult>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result.exitCode).toBe(42);
      expect(envelope.result.timedOut).toBe(false);
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('wait --exit returns for an already-exited session', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome, ['/bin/sh', '-c', 'exit 0']);
      await sleep(700);

      const session = inspectSession(testHome, sessionId);
      expect(session.status).toBe('exited');

      const waitResult = runCli(
        ['wait', sessionId, '--exit', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const envelope = JSON.parse(
        waitResult.stdout,
      ) as SuccessEnvelope<WaitResult>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result.exitCode).toBe(0);
      expect(envelope.result.timedOut).toBe(false);
    } finally {
      destroySession(testHome, sessionId);
    }
  });
});
