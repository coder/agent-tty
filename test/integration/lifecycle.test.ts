import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionRecordSchema } from '../../src/protocol/schemas.js';
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
  name?: string;
  pid: number | null;
}

interface GcResult {
  removedSessions: string[];
  skippedSessions: Array<{
    sessionId: string;
    reason: string;
  }>;
  dryRun: boolean;
  totalBytesFreed: number;
}

let testHome = '';

describe('lifecycle integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    // prettier-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-terminal-home-')));
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
    const listedSession = listEnvelope.result.sessions.find(
      (session) => session.sessionId === sessionId,
    );
    expect(listedSession).toBeDefined();
    expect(listedSession).toMatchObject({
      sessionId,
      status: 'running',
    });
    expect(listedSession?.name).toBeUndefined();
    expect(listedSession?.pid).toBeTypeOf('number');

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
    expect(listedSession?.pid).toBe(inspectEnvelope.result.session.childPid);

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
    const destroyedSession = allSessions.find(
      (session) => session.sessionId === sessionId,
    );
    expect(destroyedSession).toBeDefined();
    expect(destroyedSession).toMatchObject({
      sessionId,
      status: 'destroyed',
    });
    expect(destroyedSession?.name).toBeUndefined();

    const destroyedManifest = inspectSession(testHome, sessionId);
    expect(destroyedSession?.pid).toBe(destroyedManifest.childPid ?? null);
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

    const listResult = runCli(['list', '--all', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(listResult.status).toBe(0);
    expect(listResult.stderr).toBe('');
    const listEnvelope = JSON.parse(listResult.stdout) as SuccessEnvelope<{
      sessions: SessionSummary[];
    }>;
    const listedSession = listEnvelope.result.sessions.find(
      (session) => session.sessionId === sessionId,
    );
    expect(listedSession).toBeDefined();
    expect(listedSession).toMatchObject({
      sessionId,
      status: 'exited',
      name: 'my-session',
    });
    expect(listedSession?.pid).toBe(manifest.childPid ?? null);

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

  it('persists a provided idle timeout in the session manifest', async () => {
    const createResult = runCli(
      [
        'create',
        '--idle-timeout-ms',
        '5000',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'sleep 30',
      ],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    const manifest = SessionRecordSchema.parse(
      JSON.parse(
        await readFile(
          join(testHome, 'sessions', sessionId, 'session.json'),
          'utf8',
        ),
      ) as unknown,
    );
    expect(manifest.idleTimeoutMs).toBe(5000);
  });

  it('accepts an idle timeout of 0 without persisting it in the manifest', async () => {
    const createResult = runCli(
      [
        'create',
        '--idle-timeout-ms',
        '0',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'sleep 30',
      ],
      { AGENT_TERMINAL_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    const manifest = JSON.parse(
      await readFile(
        join(testHome, 'sessions', sessionId, 'session.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('idleTimeoutMs');
    expect(SessionRecordSchema.parse(manifest)).not.toHaveProperty(
      'idleTimeoutMs',
    );
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

    const createResult = runCli(['create', '--shell', shellPath, '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
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
      [
        'create',
        '--env',
        'MALFORMED',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'exit 0',
      ],
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

  it('host crash reconciles to failed with failureReason and failureOrigin', async () => {
    const sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);

    const beforeCrash = inspectSession(testHome, sessionId);
    expect(beforeCrash.status).toBe('running');

    crashSession(testHome, sessionId);
    await sleep(500);

    const afterCrash = inspectSession(testHome, sessionId);
    expect(afterCrash.status).toBe('failed');
    expect(afterCrash.failureReason).toBeTypeOf('string');
    const failureReason = afterCrash.failureReason as string;
    expect(failureReason.length).toBeGreaterThan(0);
    expect(failureReason).toContain('host process died unexpectedly');
    expect(afterCrash.failureOrigin).toBe('host-death');
    expect(afterCrash.hostPid).toBeNull();
    expect(afterCrash.childPid).toBeNull();
  });

  it('stale host recovery: create → crash → reconcile → gc', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'echo stale-host-proof; exec cat',
    ]);
    const sessionDirectory = join(testHome, 'sessions', sessionId);

    const runningSession = inspectSession(testHome, sessionId);
    expect(
      runningSession.status,
      'newly created session should be running before the host crash',
    ).toBe('running');
    expect(
      runningSession.hostPid,
      'inspect should record the live host PID before the host crash',
    ).toBeTypeOf('number');
    const hostPid = runningSession.hostPid;
    if (hostPid === null) {
      throw new Error(
        'hostPid must not be null after asserting that inspect returned a number',
      );
    }
    await expect(
      stat(sessionDirectory),
      'session directory should exist on disk before stale-host reconciliation',
    ).resolves.toBeDefined();

    crashSession(testHome, sessionId);
    await sleep(1000);

    const listResult = runCli(['list', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(
      listResult.status,
      'list should succeed while reconciling a stale host session',
    ).toBe(0);
    expect(
      listResult.stderr,
      'list should not write stderr while reconciling a stale host session',
    ).toBe('');
    const listEnvelope = JSON.parse(listResult.stdout) as SuccessEnvelope<{
      sessions: SessionSummary[];
    }>;
    expect(
      listEnvelope.ok,
      'list should emit a success envelope while reconciling a stale host session',
    ).toBe(true);
    expect(
      listEnvelope.result.sessions.find(
        (session) => session.sessionId === sessionId,
      ),
      'default list should hide the reconciled terminal session after stale-host recovery',
    ).toBeUndefined();

    const listAllResult = runCli(['list', '--all', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(
      listAllResult.status,
      'list --all should succeed after stale-host reconciliation',
    ).toBe(0);
    expect(
      listAllResult.stderr,
      'list --all should not write stderr after stale-host reconciliation',
    ).toBe('');
    const listAllEnvelope = JSON.parse(
      listAllResult.stdout,
    ) as SuccessEnvelope<{
      sessions: SessionSummary[];
    }>;
    expect(
      listAllEnvelope.ok,
      'list --all should emit a success envelope after stale-host reconciliation',
    ).toBe(true);
    expect(
      listAllEnvelope.result.sessions,
      'list --all should surface the reconciled stale session as failed',
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId, status: 'failed' }),
      ]),
    );

    const reconciledSession = inspectSession(testHome, sessionId);
    expect(
      reconciledSession.status,
      'inspect should report the stale host session as failed after reconciliation',
    ).toBe('failed');
    expect(
      reconciledSession.hostPid,
      'reconciled session should clear the stale host PID',
    ).toBeNull();
    expect(
      reconciledSession.childPid,
      'reconciled session should clear the orphaned child PID',
    ).toBeNull();
    expect(
      reconciledSession.failureReason,
      'reconciled session should keep a descriptive failureReason',
    ).toBeTypeOf('string');
    const failureReason = reconciledSession.failureReason;
    if (typeof failureReason !== 'string') {
      throw new Error(
        'failureReason must be a string after asserting its runtime type',
      );
    }
    expect(
      failureReason.length,
      'failureReason should not be empty after stale-host reconciliation',
    ).toBeGreaterThan(0);
    expect(
      failureReason,
      'failureReason should explain that the host died unexpectedly',
    ).toContain('host process died unexpectedly');
    expect(
      reconciledSession.failureOrigin,
      'reconciled session should keep a structured failureOrigin',
    ).toBe('host-death');

    expect(
      failureReason,
      'failureReason should preserve the stale host PID that was reconciled',
    ).toContain(String(hostPid));

    const gcResult = runCli(['gc', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(
      gcResult.status,
      'gc should succeed after stale-host reconciliation produces a terminal session',
    ).toBe(0);
    expect(
      gcResult.stderr,
      'gc should not write stderr when collecting a reconciled stale session',
    ).toBe('');
    const gcEnvelope = JSON.parse(gcResult.stdout) as SuccessEnvelope<GcResult>;
    expect(
      gcEnvelope.ok,
      'gc should emit a success envelope after collecting a stale session',
    ).toBe(true);
    expect(
      gcEnvelope.command,
      'gc envelope should identify the gc command',
    ).toBe('gc');
    expect(
      gcEnvelope.result.removedSessions,
      'gc should remove the reconciled stale session directory',
    ).toEqual([sessionId]);
    expect(
      gcEnvelope.result.skippedSessions,
      'gc should not skip the reconciled stale session',
    ).toEqual([]);
    expect(
      gcEnvelope.result.totalBytesFreed,
      'gc should report reclaimed bytes for the removed session directory',
    ).toBeGreaterThan(0);

    const listAfterGcResult = runCli(['list', '--all', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(
      listAfterGcResult.status,
      'list --all should succeed after gc removes the stale session',
    ).toBe(0);
    expect(
      listAfterGcResult.stderr,
      'list --all should stay silent after gc removes the stale session',
    ).toBe('');
    const listAfterGcEnvelope = JSON.parse(
      listAfterGcResult.stdout,
    ) as SuccessEnvelope<{
      sessions: SessionSummary[];
    }>;
    expect(
      listAfterGcEnvelope.ok,
      'list --all should emit a success envelope after gc removes the stale session',
    ).toBe(true);
    expect(
      listAfterGcEnvelope.result.sessions.find(
        (session) => session.sessionId === sessionId,
      ),
      'list --all should no longer include the gc-collected stale session',
    ).toBeUndefined();
    await expect(
      stat(sessionDirectory),
      'gc should remove the stale session directory from disk',
    ).rejects.toMatchObject({ code: 'ENOENT' });
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
    const snapshotEnvelope = JSON.parse(
      snapshotResult.stdout,
    ) as SuccessEnvelope<{
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

  it('send-keys to non-existent session returns SESSION_NOT_FOUND', () => {
    const result = runCli(['send-keys', 'NONEXISTENT', 'Enter', '--json'], {
      AGENT_TERMINAL_HOME: testHome,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('destroy non-existent session returns SESSION_NOT_FOUND', () => {
    const result = runCli(['destroy', 'NONEXISTENT', '--json'], {
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
