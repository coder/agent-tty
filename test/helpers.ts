import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { SessionRecord as ProtocolSessionRecord } from '../src/protocol/schemas.js';
import { parseProcStat } from '../src/host/programGroup.js';
import type { SemanticSnapshot } from '../src/renderer/types.js';
import { hasErrorCode } from '../src/util/hasErrorCode.js';

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

export function parseWaitTimeoutEnvelope(
  stdout: string,
): Record<string, unknown> {
  const envelope = JSON.parse(stdout) as {
    ok: boolean;
    command: string;
    error?: { code: string; retryable: boolean };
    result: Record<string, unknown>;
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.command).toBe('wait');
  expect(envelope.error?.code).toBe('WAIT_TIMEOUT');
  expect(envelope.error?.retryable).toBe(false);
  return envelope.result;
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
  const sessionDirectory = join(home, sessionId);
  await mkdir(sessionDirectory);
  return sessionDirectory;
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
  env?: Record<string, string>;
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
    ...options.env,
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

// Returns the pid of the host that it killed.
export function crashSession(testHome: string, sessionId: string): number {
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
  return hostPid;
}

// A killed process stays a zombie until its parent, init here, reaps it.
export async function processEnds(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (hasErrorCode(error, 'ESRCH')) {
        return true;
      }
      throw error;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(50);
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

// The host records the program's session token only where /proc shows an
// autogroup and the boot id, which a Linux kernel without
// CONFIG_SCHED_AUTOGROUP or a hardened /proc does not.
export const capturesToken = ((): boolean => {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    return (
      /^\/autogroup-\d+ /.test(readFileSync('/proc/self/autogroup', 'utf8')) &&
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== ''
    );
  } catch {
    return false;
  }
})();

export function isGroupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return false;
    }
    throw error;
  }
}

export function killGroupIfAlive(group: number): void {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (!hasErrorCode(error, 'ESRCH')) {
      throw error;
    }
  }
}

const GONE_CODES = ['ENOENT', 'ESRCH'];

function isGone(error: unknown): boolean {
  return GONE_CODES.some((code) => hasErrorCode(error, code));
}

// Whether /proc shows the processes of every user. hidepid leaves other
// users out, and an unreadable mountinfo counts as hiding them.
function procShowsEveryUser(): boolean {
  let mountinfo: string;
  try {
    mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return false;
  }
  let shows = false;
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (fields[4] === '/proc' && fields[separator + 1] === 'proc') {
      shows = !/(^|,)hidepid=(2|4|invisible|ptraceable)(,|$)/.test(
        fields[separator + 3] ?? '',
      );
    }
  }
  return shows;
}

// Whether a scan of /proc shows a thread of the group that is not a zombie,
// or null when a read is refused or the scan shows no member at all, as a
// /proc of another pid namespace does, so the scan proves nothing.
function scanFindsLiveThread(group: number): boolean | null {
  let seen = false;
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      let tasks: string[];
      try {
        if (
          parseProcStat(readFileSync(`/proc/${entry}/stat`, 'utf8')).pgid !==
          group
        ) {
          continue;
        }
        seen = true;
        tasks = readdirSync(`/proc/${entry}/task`);
      } catch (error) {
        if (isGone(error)) {
          continue;
        }
        throw error;
      }
      for (const task of tasks) {
        let state: string;
        try {
          state = parseProcStat(
            readFileSync(`/proc/${entry}/task/${task}/stat`, 'utf8'),
          ).state;
        } catch (error) {
          if (isGone(error)) {
            continue;
          }
          throw error;
        }
        if (state !== 'Z' && state !== 'X') {
          return true;
        }
      }
    }
  } catch (error) {
    if (
      ['EACCES', 'EPERM', 'ENOENT'].some((code) => hasErrorCode(error, code))
    ) {
      return null;
    }
    throw error;
  }
  return seen ? false : null;
}

// A killed process stays a zombie until its parent reaps it. An orphan's
// parent is init, which can take seconds to reap on a loaded machine, so on
// Linux a group whose threads are all zombies counts as ended. A process can
// fork and end between the /proc listing and its own read, so two scans must
// agree. Where /proc cannot show the whole group, the probe decides alone.
function groupHasLiveThread(group: number): boolean {
  if (!isGroupAlive(group)) {
    return false;
  }
  if (process.platform !== 'linux' || !procShowsEveryUser()) {
    return true;
  }
  return (
    scanFindsLiveThread(group) !== false || scanFindsLiveThread(group) !== false
  );
}

export async function groupEnds(group: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (groupHasLiveThread(group)) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(50);
  }
  return true;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
