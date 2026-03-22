import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  crashSession,
  createSession,
  destroySession,
  inspectSession,
  runCli,
  sleep,
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
        expect.objectContaining({ sessionId, status: 'destroyed' }),
      ]),
    );
  });

  it('stores name/env/term in the manifest and passes env to the PTY', async () => {
    const createResult = runCli(
      [
        'create',
        '--name',
        'my-session',
        '--env',
        'FOO=bar',
        '--env',
        'BAZ=qux',
        '--term',
        'vt100',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'printf "%s|%s|%s" "$FOO" "$BAZ" "$TERM"; exit 0',
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

    const manifest = JSON.parse(
      await readFile(
        join(testHome, 'sessions', sessionId, 'session.json'),
        'utf8',
      ),
    ) as SessionRecord & {
      name?: string;
      env?: Record<string, string>;
      term?: string;
    };
    expect(manifest.name).toBe('my-session');
    expect(manifest.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(manifest.term).toBe('vt100');

    const eventContent = await readFile(
      join(testHome, 'sessions', sessionId, 'events.jsonl'),
      'utf8',
    );
    const events = eventContent
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EventRecord);
    const allOutput = events
      .filter((event) => event.type === 'output')
      .map((event) => {
        const data = event.payload.data;
        return typeof data === 'string' ? data : '';
      })
      .join('');
    expect(allOutput).toContain('bar|qux|vt100');
  });

  it('uses the provided shell path for shell-only sessions', async () => {
    const shellPath = join(testHome, 'custom-shell.sh');
    const shellMarkerPath = join(testHome, 'custom-shell.log');
    await writeFile(
      shellPath,
      [
        '#!/bin/sh',
        `printf "custom-shell\\n" >> "${shellMarkerPath}"`,
        'exec /bin/sh "$@"',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(shellPath, 0o755);

    const createResult = runCli(
      ['create', '--shell', shellPath, '--json'],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });

    const manifest = JSON.parse(
      await readFile(
        join(testHome, 'sessions', sessionId, 'session.json'),
        'utf8',
      ),
    ) as SessionRecord;
    expect(manifest.command).toEqual([shellPath]);
    expect(await readFile(shellMarkerPath, 'utf8')).toContain('custom-shell');

    const typeResult = runCli(['type', sessionId, 'exit\n', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(typeResult.status).toBe(0);
    expect(typeResult.stderr).toBe('');
  });

  it('rejects malformed --env entries', () => {
    const createResult = runCli(
      ['create', '--env', 'MALFORMED', '--json', '--', '/bin/sh', '-c', 'exit 0'],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(2);
    expect(createResult.stderr).toBe('');

    const errorEnvelope = JSON.parse(createResult.stdout) as ErrorEnvelope;
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.error.code).toBe('INVALID_INPUT');
    expect(errorEnvelope.error.message).toContain('KEY=VALUE');
  });

  it('rejects a missing shell path override', () => {
    const missingShellPath = join(testHome, 'missing-shell.sh');
    const createResult = runCli(
      ['create', '--shell', missingShellPath, '--json'],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(2);
    expect(createResult.stderr).toBe('');

    const errorEnvelope = JSON.parse(createResult.stdout) as ErrorEnvelope;
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.error.code).toBe('INVALID_INPUT');
    expect(errorEnvelope.error.message).toContain(missingShellPath);
  });

  it('host crash reconciles to failed with failureReason', async () => {
    const sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);

    const beforeCrash = inspectSession(testHome, sessionId);
    expect(beforeCrash.status).toBe('running');

    crashSession(testHome, sessionId);
    await sleep(500);

    const afterCrash = inspectSession(testHome, sessionId);
    expect(afterCrash.status).toBe('failed');
    expect(afterCrash.failureReason).toBeTypeOf('string');
    expect(afterCrash.failureReason!.length).toBeGreaterThan(0);
    expect(afterCrash.failureReason).toContain('host process died unexpectedly');
    expect(afterCrash.hostPid).toBeNull();
    expect(afterCrash.childPid).toBeNull();
  });

  it('destroyed session rejects commands with SESSION_ALREADY_DESTROYED', () => {
    const sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);

    destroySession(testHome, sessionId);

    const session = inspectSession(testHome, sessionId);
    expect(session.status).toBe('destroyed');

    const typeResult = runCli(['type', sessionId, 'hello', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(typeResult.status).not.toBe(0);
    expect(typeResult.stderr).toBe('');
    const envelope = JSON.parse(typeResult.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_ALREADY_DESTROYED');
  });

  it('failed session supports offline snapshot', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'echo offline-test-data; exec cat',
    ]);

    await sleep(1000);

    crashSession(testHome, sessionId);
    await sleep(500);

    const session = inspectSession(testHome, sessionId);
    expect(session.status).toBe('failed');

    const snapshotResult = runCli(
      ['snapshot', sessionId, '--format', 'text', '--json'],
      {
        AGENT_TERMINAL_HOME: testHome,
      },
    );
    expect(snapshotResult.status).toBe(0);
    expect(snapshotResult.stderr).toBe('');
    const snapshotEnvelope = JSON.parse(snapshotResult.stdout) as SuccessEnvelope<{
      text: string;
      format: string;
    }>;
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.result.format).toBe('text');
    expect(snapshotEnvelope.result.text).toContain('offline-test-data');
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
