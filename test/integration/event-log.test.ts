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

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
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

  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
    sessionId: string;
  }>;
  expect(envelope.ok).toBe(true);
  return envelope.result.sessionId;
}

async function readEvents(
  testHome: string,
  sessionId: string,
): Promise<EventRecord[]> {
  const eventsPath = join(testHome, 'sessions', sessionId, 'events.jsonl');
  const content = await readFile(eventsPath, 'utf8');

  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
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

function runMixedActionSequence(testHome: string, sessionId: string): void {
  const env = { AGENT_TERMINAL_HOME: testHome };

  const typeResult = runCli(['type', sessionId, 'hello', '--json'], env);
  expect(typeResult.status).toBe(0);
  expect(typeResult.stderr).toBe('');

  const sendKeysResult = runCli(
    ['send-keys', sessionId, 'Enter', '--json'],
    env,
  );
  expect(sendKeysResult.status).toBe(0);
  expect(sendKeysResult.stderr).toBe('');

  const pasteResult = runCli(['paste', sessionId, 'paste-text', '--json'], env);
  expect(pasteResult.status).toBe(0);
  expect(pasteResult.stderr).toBe('');

  const resizeResult = runCli(
    ['resize', sessionId, '--cols', '100', '--rows', '30', '--json'],
    env,
  );
  expect(resizeResult.status).toBe(0);
  expect(resizeResult.stderr).toBe('');

  const waitResult = runCli(
    ['wait', sessionId, '--idle-ms', '500', '--timeout', '5000', '--json'],
    env,
    30000,
  );
  expect(waitResult.status).toBe(0);
  expect(waitResult.stderr).toBe('');
  const envelope = JSON.parse(waitResult.stdout) as SuccessEnvelope<WaitResult>;
  expect(envelope.ok).toBe(true);
  expect(envelope.result.timedOut).toBe(false);
}

let testHome = '';

describe('event-log integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'agent-terminal-home-'));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('mixed action sequence has monotonic seq', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      runMixedActionSequence(testHome, sessionId);
      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      expect(events.length).toBeGreaterThan(0);
      expect(events.map((event) => event.seq)).toEqual(
        events.map((_, index) => index),
      );

      const eventTypes = new Set(events.map((event) => event.type));
      expect([...eventTypes]).toEqual(
        expect.arrayContaining([
          'input_text',
          'input_keys',
          'input_paste',
          'resize',
          'output',
        ]),
      );
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('all event records validate against expected structure', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      runMixedActionSequence(testHome, sessionId);
      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        expect(typeof event.seq).toBe('number');
        expect(Number.isInteger(event.seq)).toBe(true);
        expect(event.seq).toBeGreaterThanOrEqual(0);
        expect(typeof event.ts).toBe('string');
        expect(new Date(event.ts).toISOString()).toBe(event.ts);
        expect(typeof event.type).toBe('string');
        expect(event.type.length).toBeGreaterThan(0);
        expect(typeof event.payload).toBe('object');
        expect(event.payload).not.toBeNull();
        expect(Array.isArray(event.payload)).toBe(false);
      }
    } finally {
      destroySession(testHome, sessionId);
    }
  });
});
