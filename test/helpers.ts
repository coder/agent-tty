import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { SessionRecord as ProtocolSessionRecord } from '../src/protocol/schemas.js';
import type { SemanticSnapshot } from '../src/renderer/types.js';

import { afterEach, expect } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const DEFAULT_CLI_TIMEOUT_MS = 30_000;

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  exitCode: number;
}

export interface SuccessEnvelope<TResult> {
  ok: true;
  command: string;
  timestamp: string;
  result: TResult;
}

export interface SessionRecord {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  command: string[];
  cwd: string;
  name?: string;
  env?: Record<string, string>;
  term?: string;
  cols: number;
  rows: number;
  hostPid: number | null;
  childPid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  failureOrigin?: string;
  failureReason?: string;
}

export interface EventRecord {
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface WaitResult {
  exitCode?: number;
  timedOut: boolean;
}

export function createTestSemanticSnapshot(
  overrides: Partial<SemanticSnapshot> = {},
): SemanticSnapshot {
  return {
    sessionId: 'session-01',
    capturedAtSeq: 5,
    cols: 80,
    rows: 24,
    cursorRow: 0,
    cursorCol: 0,
    isAltScreen: false,
    visibleLines: [{ row: 0, text: 'offline output' }],
    ...overrides,
  };
}

export function createTestSessionRecord(
  overrides: Partial<ProtocolSessionRecord> = {},
): ProtocolSessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
    ...overrides,
  };
}

export async function createTemporarySessionDir(
  prefix: string,
  sessionId = 'session-01',
): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(home);
  return join(home, sessionId);
}

export function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeout = DEFAULT_CLI_TIMEOUT_MS,
): CommandResult {
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
    exitCode: result.status ?? 1,
  };
}

export async function cleanupHome(home: string): Promise<void> {
  if (home.length === 0) {
    return;
  }

  try {
    const sessionsDir = join(home, 'sessions');
    const entries = await readdir(sessionsDir).catch((): string[] => []);

    for (const entry of entries) {
      const manifestFile = join(sessionsDir, entry, 'session.json');

      try {
        const manifest = JSON.parse(
          await readFile(manifestFile, 'utf8'),
        ) as Record<string, unknown>;

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

interface CreateSessionOptions {
  cols?: number;
  rows?: number;
}

export function createSession(
  testHome: string,
  command: string[] = ['/bin/sh', '-c', 'exec cat'],
  options: CreateSessionOptions = {},
): string {
  const args = ['create', '--json'];
  if (options.cols !== undefined) {
    args.push('--cols', String(options.cols));
  }
  if (options.rows !== undefined) {
    args.push('--rows', String(options.rows));
  }
  args.push('--', ...command);

  const result = runCli(args, {
    AGENT_TTY_HOME: testHome,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
    sessionId: string;
  }>;
  expect(envelope.ok).toBe(true);
  return envelope.result.sessionId;
}

export function destroySession(testHome: string, sessionId: string): void {
  if (sessionId.length === 0) {
    return;
  }

  runCli(['destroy', sessionId, '--json'], {
    AGENT_TTY_HOME: testHome,
  });
}

export function crashSession(testHome: string, sessionId: string): void {
  const session = inspectSession(testHome, sessionId);
  const hostPid = session.hostPid;
  expect(hostPid).toBeTypeOf('number');
  if (hostPid === null) {
    throw new Error(
      'hostPid must not be null (assertion above should have caught this)',
    );
  }

  try {
    process.kill(hostPid, 'SIGKILL');
  } catch {
    // Process may already be dead
  }
}

export function inspectSession(
  testHome: string,
  sessionId: string,
): SessionRecord {
  const result = runCli(['inspect', sessionId, '--json'], {
    AGENT_TTY_HOME: testHome,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');

  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
    session: SessionRecord;
  }>;
  expect(envelope.ok).toBe(true);
  return envelope.result.session;
}

export async function readEvents(
  testHome: string,
  sessionId: string,
): Promise<EventRecord[]> {
  const eventsPath = join(testHome, 'sessions', sessionId, 'events.jsonl');
  const content = await readFile(eventsPath, 'utf8');

  if (content.trim().length === 0) {
    return [];
  }

  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
