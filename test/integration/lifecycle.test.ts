import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  runCli,
  type EventRecord,
  type SessionRecord,
  type SuccessEnvelope,
} from '../helpers.js';

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
      .map((event) => {
        const data = event.payload.data;
        return typeof data === 'string' ? data : '';
      })
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
