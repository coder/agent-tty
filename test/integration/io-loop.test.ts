import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface SuccessEnvelope<TResult> {
  ok: true;
  command: string;
  result: TResult;
}

interface SessionRecord {
  version: 1;
  sessionId: string;
  status: string;
  command: string[];
  cwd: string;
  cols: number;
  rows: number;
  hostPid: number | null;
  childPid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventRecord {
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

interface WaitResult {
  exitCode?: number;
  timedOut: boolean;
}

function runCli(
  args: string[],
  env?: Record<string, string>,
  timeout = 15000,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', './src/cli/main.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout,
    },
  );

  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

async function cleanupHome(home: string): Promise<void> {
  try {
    const sessionsDir = join(home, 'sessions');
    const entries = await readdir(sessionsDir).catch((): string[] => []);

    for (const entry of entries) {
      const manifestFile = join(sessionsDir, entry, 'session.json');

      try {
        const raw = await readFile(manifestFile, 'utf8');
        const manifest = JSON.parse(raw) as Record<string, unknown>;

        for (const pidKey of ['childPid', 'hostPid'] as const) {
          const pid = manifest[pidKey];
          if (typeof pid === 'number' && pid > 0) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // best-effort cleanup, ignore errors
            }
          }
        }
      } catch {
        // best-effort cleanup, ignore errors
      }
    }
  } catch {
    // best-effort cleanup, ignore errors
  }

  await rm(home, { recursive: true, force: true });
}

function createSession(
  testHome: string,
  command: string[] = ['/bin/sh', '-c', 'exec cat'],
): string {
  const result = runCli(['create', '--json', '--', ...command], {
    AGENT_TERMINAL_HOME: testHome,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{ sessionId: string }>;
  expect(envelope.ok).toBe(true);
  return envelope.result.sessionId;
}

async function readEvents(testHome: string, sessionId: string): Promise<EventRecord[]> {
  const eventsPath = join(testHome, 'sessions', sessionId, 'events.jsonl');
  const content = await readFile(eventsPath, 'utf8');

  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function inspectSession(testHome: string, sessionId: string): SessionRecord {
  const result = runCli(['inspect', sessionId, '--json'], {
    AGENT_TERMINAL_HOME: testHome,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
    session: SessionRecord;
  }>;
  expect(envelope.ok).toBe(true);
  return envelope.result.session;
}

function destroySession(testHome: string, sessionId: string): void {
  if (sessionId.length === 0) {
    return;
  }

  runCli(['destroy', sessionId, '--force', '--json'], {
    AGENT_TERMINAL_HOME: testHome,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

      const typeResult = runCli(['type', sessionId, 'echo test-marker', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(typeResult.status).toBe(0);
      expect(typeResult.stderr).toBe('');

      const sendKeysResult = runCli(['send-keys', sessionId, 'Enter', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(sendKeysResult.status).toBe(0);
      expect(sendKeysResult.stderr).toBe('');

      const waitResult = runCli(
        ['wait', sessionId, '--idle-ms', '500', '--timeout', '5000', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const envelope = JSON.parse(waitResult.stdout) as SuccessEnvelope<WaitResult>;
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
      const signalEnvelope = JSON.parse(signalResult.stdout) as SuccessEnvelope<{
        signal: string;
        delivered: boolean;
      }>;
      expect(signalEnvelope.ok).toBe(true);
      expect(signalEnvelope.result).toEqual({ signal: 'SIGTERM', delivered: true });

      const waitResult = runCli(
        ['wait', sessionId, '--exit', '--timeout', '5000', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
        30000,
      );
      expect(waitResult.status).toBe(0);
      expect(waitResult.stderr).toBe('');
      const waitEnvelope = JSON.parse(waitResult.stdout) as SuccessEnvelope<WaitResult>;
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
      const envelope = JSON.parse(waitResult.stdout) as SuccessEnvelope<WaitResult>;
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
      const envelope = JSON.parse(waitResult.stdout) as SuccessEnvelope<WaitResult>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result.exitCode).toBe(0);
      expect(envelope.result.timedOut).toBe(false);
    } finally {
      destroySession(testHome, sessionId);
    }
  });
});
