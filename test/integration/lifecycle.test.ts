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

interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

interface SessionSummary {
  sessionId: string;
  status: string;
  command: string[];
  createdAt: string;
}

interface SessionRecord extends SessionSummary {
  version: 1;
  updatedAt: string;
  cwd: string;
  cols: number;
  rows: number;
  hostPid: number | null;
  childPid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
}

interface EventRecord {
  seq: number;
  ts: string;
  type: string;
  payload: {
    data?: string;
    exitCode?: number;
  };
}

function runCli(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', './src/cli/main.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 15000,
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

let testHome = '';

describe('lifecycle integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'agent-terminal-home-'));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('full lifecycle: create → list → inspect → destroy', () => {
    const createResult = runCli(
      ['create', '--json', '--', '/bin/sh', '-c', 'echo ready; sleep 30'],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const createEnvelope = JSON.parse(createResult.stdout) as SuccessEnvelope<{
      sessionId: string;
    }>;
    expect(createEnvelope.ok).toBe(true);
    const sessionId = createEnvelope.result.sessionId;
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const listResult = runCli(['list', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(listResult.status).toBe(0);
    expect(listResult.stderr).toBe('');
    const listEnvelope = JSON.parse(listResult.stdout) as SuccessEnvelope<{
      sessions: SessionSummary[];
    }>;
    expect(listEnvelope.ok).toBe(true);
    expect(listEnvelope.result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId, status: 'running' }),
      ]),
    );

    const inspectResult = runCli(['inspect', sessionId, '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(inspectResult.status).toBe(0);
    expect(inspectResult.stderr).toBe('');
    const inspectEnvelope = JSON.parse(
      inspectResult.stdout,
    ) as SuccessEnvelope<{
      session: SessionRecord;
    }>;
    expect(inspectEnvelope.ok).toBe(true);
    expect(inspectEnvelope.result.session.sessionId).toBe(sessionId);
    expect(inspectEnvelope.result.session.status).toBe('running');
    expect(inspectEnvelope.result.session.hostPid).toBeTypeOf('number');
    expect(inspectEnvelope.result.session.childPid).toBeTypeOf('number');

    const destroyResult = runCli(['destroy', sessionId, '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
    expect(destroyResult.stderr).toBe('');
    const destroyEnvelope = JSON.parse(
      destroyResult.stdout,
    ) as SuccessEnvelope<{
      sessionId: string;
      destroyed: boolean;
    }>;
    expect(destroyEnvelope.ok).toBe(true);
    expect(destroyEnvelope.result.destroyed).toBe(true);
  });

  it('exited sessions hidden by default list, visible with --all', () => {
    const createResult = runCli(
      ['create', '--json', '--', '/bin/sh', '-c', 'echo done; sleep 30'],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    const destroyResult = runCli(['destroy', sessionId, '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
    expect(destroyResult.stderr).toBe('');

    const listDefault = runCli(['list', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(listDefault.status).toBe(0);
    expect(listDefault.stderr).toBe('');
    const defaultSessions = (
      JSON.parse(listDefault.stdout) as SuccessEnvelope<{
        sessions: SessionSummary[];
      }>
    ).result.sessions;
    expect(
      defaultSessions.find((session) => session.sessionId === sessionId),
    ).toBeUndefined();

    const listAll = runCli(['list', '--all', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(listAll.status).toBe(0);
    expect(listAll.stderr).toBe('');
    const allSessions = (
      JSON.parse(listAll.stdout) as SuccessEnvelope<{
        sessions: SessionSummary[];
      }>
    ).result.sessions;
    expect(allSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId, status: 'exited' }),
      ]),
    );
  });

  it('inspect nonexistent session returns SESSION_NOT_FOUND', () => {
    const result = runCli(['inspect', 'NONEXISTENT', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('event log contains output and exit records', async () => {
    const createResult = runCli(
      [
        'create',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'echo marker-test-output; exit 0',
      ],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2000);
    });

    const eventsPath = join(testHome, 'sessions', sessionId, 'events.jsonl');
    const eventContent = await readFile(eventsPath, 'utf8');
    const events = eventContent
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EventRecord);

    const outputEvents = events.filter((event) => event.type === 'output');
    expect(outputEvents.length).toBeGreaterThan(0);

    const allOutput = outputEvents
      .map((event) => event.payload.data ?? '')
      .join('');
    expect(allOutput).toContain('marker-test-output');

    const exitEvents = events.filter((event) => event.type === 'exit');
    expect(exitEvents.length).toBe(1);
    expect(exitEvents[0]?.payload.exitCode).toBe(0);

    const destroyResult = runCli(['destroy', sessionId, '--force', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
  });
});
