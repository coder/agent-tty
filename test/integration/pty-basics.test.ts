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

describe('pty-basics integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'agent-terminal-home-'));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('type writes and records input_text', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const typeResult = runCli(['type', sessionId, 'hello', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(typeResult.status).toBe(0);
      expect(typeResult.stderr).toBe('');
      const envelope = JSON.parse(typeResult.stdout) as SuccessEnvelope<Record<string, never>>;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputTextEvents = events.filter((event) => event.type === 'input_text');
      expect(inputTextEvents.length).toBeGreaterThan(0);
      expect(inputTextEvents[0]?.payload.data).toBe('hello');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('send-keys Enter records input_keys', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const sendKeysResult = runCli(['send-keys', sessionId, 'Enter', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(sendKeysResult.status).toBe(0);
      expect(sendKeysResult.stderr).toBe('');
      const envelope = JSON.parse(sendKeysResult.stdout) as SuccessEnvelope<Record<string, never>>;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputKeyEvents = events.filter((event) => event.type === 'input_keys');
      expect(inputKeyEvents.length).toBeGreaterThan(0);
      expect(inputKeyEvents[0]?.payload.keys).toEqual(['Enter']);
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('paste records input_paste with bracketed paste markers', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const pasteResult = runCli(['paste', sessionId, 'test-text', '--json'], {
        AGENT_TERMINAL_HOME: testHome,
      });
      expect(pasteResult.status).toBe(0);
      expect(pasteResult.stderr).toBe('');
      const envelope = JSON.parse(pasteResult.stdout) as SuccessEnvelope<Record<string, never>>;
      expect(envelope.ok).toBe(true);

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const inputPasteEvents = events.filter((event) => event.type === 'input_paste');
      expect(inputPasteEvents.length).toBeGreaterThan(0);

      const data = inputPasteEvents[0]?.payload.data;
      expect(typeof data).toBe('string');
      expect(data).toContain('\u001b[200~');
      expect(data).toContain('test-text');
      expect(data).toContain('\u001b[201~');
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('resize records resize and inspect reflects new dimensions', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      const resizeResult = runCli(
        ['resize', sessionId, '--cols', '120', '--rows', '40', '--json'],
        { AGENT_TERMINAL_HOME: testHome },
      );
      expect(resizeResult.status).toBe(0);
      expect(resizeResult.stderr).toBe('');
      const envelope = JSON.parse(resizeResult.stdout) as SuccessEnvelope<{
        cols: number;
        rows: number;
      }>;
      expect(envelope.ok).toBe(true);
      expect(envelope.result).toEqual({ cols: 120, rows: 40 });

      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      const resizeEvents = events.filter((event) => event.type === 'resize');
      expect(resizeEvents.length).toBeGreaterThan(0);
      expect(resizeEvents[0]?.payload).toEqual({ cols: 120, rows: 40 });

      const session = inspectSession(testHome, sessionId);
      expect(session.cols).toBe(120);
      expect(session.rows).toBe(40);
    } finally {
      destroySession(testHome, sessionId);
    }
  });
});
