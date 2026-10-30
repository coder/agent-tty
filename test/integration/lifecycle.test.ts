import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isProcessAlive } from '../../src/host/lifecycle.js';
import { probeLibghosttyVt } from '../../src/renderer/readiness.js';
import { SessionRecordSchema } from '../../src/protocol/schemas.js';
import { sessionDir, socketPath } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  crashSession,
  createSession,
  destroySession,
  groupEnds,
  inspectSession,
  isGroupAlive,
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

interface GcHomeOutcome {
  home: string;
  existed: boolean;
  removedSessions: string[];
  skippedSessions: Array<{
    sessionId: string;
    reason: string;
  }>;
  totalBytesFreed: number;
  deregistered: boolean;
}

interface GcResult {
  dryRun: boolean;
  homes: GcHomeOutcome[];
  removedSessionCount: number;
  totalBytesFreed: number;
  deregisteredHomes: string[];
}

let testHome = '';

describe('lifecycle integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('full lifecycle: create → list → inspect → destroy', async () => {
    const createResult = runCli(
      ['create', '--json', '--', '/bin/sh', '-c', 'echo ready; sleep 30'],
      { AGENT_TTY_HOME: testHome },
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
      AGENT_TTY_HOME: testHome,
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

    const expectedRenderer = (await probeLibghosttyVt()).available
      ? 'libghostty-vt'
      : 'ghostty-web';
    const inspectResult = runCli(['inspect', sessionId, '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(inspectResult.status).toBe(0);
    expect(inspectResult.stderr).toBe('');
    const inspectEnvelope = JSON.parse(
      inspectResult.stdout,
    ) as SuccessEnvelope<{
      session: SessionRecord;
      rendererRuntime?: {
        backend: string;
        mode: string;
        status: string;
        reason?: string;
      };
    }>;
    expect(inspectEnvelope.ok).toBe(true);
    expect(inspectEnvelope.result.session.sessionId).toBe(sessionId);
    expect(inspectEnvelope.result.session.status).toBe('running');
    expect(inspectEnvelope.result.session.hostPid).toBeTypeOf('number');
    expect(inspectEnvelope.result.session.childPid).toBeTypeOf('number');
    expect(inspectEnvelope.result.rendererRuntime).toEqual(
      expect.objectContaining({
        backend: expectedRenderer,
        mode: 'live-host',
        status: 'healthy',
      }),
    );
    expect(listedSession?.pid).toBe(inspectEnvelope.result.session.childPid);

    const destroyResult = runCli(['destroy', sessionId, '--json'], {
      AGENT_TTY_HOME: testHome,
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
      { AGENT_TTY_HOME: testHome },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    const destroyResult = runCli(['destroy', sessionId, '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
    expect(destroyResult.stderr).toBe('');

    const listDefault = runCli(['list', '--json'], {
      AGENT_TTY_HOME: testHome,
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
      AGENT_TTY_HOME: testHome,
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
      { AGENT_TTY_HOME: testHome },
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
      AGENT_TTY_HOME: testHome,
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

  it('defaults PROMPT_EOL_MARK to empty in the spawned shell, overriding an inherited value', async () => {
    // The default is injected at PTY spawn time so it never appears in the
    // manifest; assert it by reading it back from inside the spawned shell.
    // Export a sentinel PROMPT_EOL_MARK in the parent env so this discriminates
    // the fix: only an active override yields an empty value in the child —
    // without it the shell would inherit the sentinel. (`--env` precedence is
    // covered by the resolvePtyEnv unit test; that `--env` reaches the real
    // shell is covered by the manifest/env test above.)
    const createResult = runCli(
      [
        'create',
        '--json',
        '--',
        '/bin/sh',
        '-c',
        'printf "[%s]" "$PROMPT_EOL_MARK"; exit 0',
      ],
      { AGENT_TTY_HOME: testHome, PROMPT_EOL_MARK: 'inherited-sentinel' },
    );
    expect(createResult.status).toBe(0);
    expect(createResult.stderr).toBe('');
    const sessionId = (
      JSON.parse(createResult.stdout) as SuccessEnvelope<{ sessionId: string }>
    ).result.sessionId;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2000);
    });

    const eventContent = await readFile(
      join(testHome, 'sessions', sessionId, 'events.jsonl'),
      'utf8',
    );
    const allOutput = eventContent
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EventRecord)
      .filter((event) => event.type === 'output')
      .map((event) => {
        const data = event.payload.data;
        return typeof data === 'string' ? data : '';
      })
      .join('');
    expect(allOutput).toContain('[]');
    expect(allOutput).not.toContain('inherited-sentinel');
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
      { AGENT_TTY_HOME: testHome },
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
      { AGENT_TTY_HOME: testHome },
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
      AGENT_TTY_HOME: testHome,
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
      AGENT_TTY_HOME: testHome,
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
      { AGENT_TTY_HOME: testHome },
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
      { AGENT_TTY_HOME: testHome },
    );
    expect(createResult.status).toBe(2);
    expect(createResult.stderr).toBe('');

    const errorEnvelope = JSON.parse(createResult.stdout) as ErrorEnvelope;
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.error.code).toBe('INVALID_INPUT');
    expect(errorEnvelope.error.message).toContain(missingShellPath);
  });

  it.each([
    {
      failure: 'a missing working directory',
      args: (home: string) => [
        '--cwd',
        join(home, 'missing-cwd'),
        '--',
        '/bin/sh',
      ],
      code: 'STORAGE_READ_ERROR',
    },
    {
      failure: 'a missing shell path',
      args: (home: string) => ['--shell', join(home, 'missing-shell.sh')],
      code: 'INVALID_INPUT',
    },
    {
      failure: 'an empty command segment',
      args: () => ['--', ''],
      code: 'INTERNAL_ERROR',
    },
  ])(
    'leaves no session directory behind after $failure',
    async ({ args, code }) => {
      const createResult = runCli(['create', '--json', ...args(testHome)], {
        AGENT_TTY_HOME: testHome,
      });

      const errorEnvelope = JSON.parse(createResult.stdout) as ErrorEnvelope;
      expect(errorEnvelope.ok).toBe(false);
      expect(errorEnvelope.error.code).toBe(code);
      const sessionEntries = await readdir(join(testHome, 'sessions')).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
          }
          throw error;
        },
      );
      expect(sessionEntries).toEqual([]);
    },
  );

  it('creates a session whose cwd is a Home that does not exist yet', async () => {
    const newHome = join(testHome, 'new-home');
    try {
      const createResult = runCli(
        ['create', '--json', '--cwd', newHome, '--', '/bin/sh', '-c', 'exit 0'],
        { AGENT_TTY_HOME: newHome },
      );

      const envelope = JSON.parse(createResult.stdout) as SuccessEnvelope<{
        sessionId: string;
      }>;
      expect(envelope.ok).toBe(true);
    } finally {
      await cleanupHome(newHome);
    }
  });

  it('creates a running session in a new Home behind a symlink', async () => {
    const realRoot = join(testHome, 'real');
    await mkdir(realRoot);
    await symlink(realRoot, join(testHome, 'link'));
    const env = {
      AGENT_TTY_HOME: join(testHome, 'link', 'home'),
      XDG_STATE_HOME: join(testHome, 'state'),
    };
    try {
      const createResult = runCli(
        ['create', '--json', '--', '/bin/sh', '-c', 'exec cat'],
        env,
      );
      expect(createResult.status).toBe(0);
      const envelope = JSON.parse(createResult.stdout) as SuccessEnvelope<{
        sessionId: string;
      }>;

      const inspectResult = runCli(
        ['inspect', envelope.result.sessionId, '--json'],
        env,
      );
      const inspected = JSON.parse(inspectResult.stdout) as SuccessEnvelope<{
        session: SessionRecord;
      }>;
      expect(inspected.result.session.status).toBe('running');
    } finally {
      await cleanupHome(join(realRoot, 'home'));
    }
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
      AGENT_TTY_HOME: testHome,
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
      AGENT_TTY_HOME: testHome,
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
      AGENT_TTY_HOME: testHome,
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
    // AGENT_TTY_HOME is set → gc is scoped to this one Home.
    expect(
      gcEnvelope.result.homes,
      'gc should report exactly the scoped Home',
    ).toHaveLength(1);
    expect(
      gcEnvelope.result.homes[0]?.removedSessions,
      'gc should remove the reconciled stale session directory',
    ).toEqual([sessionId]);
    expect(
      gcEnvelope.result.homes[0]?.skippedSessions,
      'gc should not skip the reconciled stale session',
    ).toEqual([]);
    expect(
      gcEnvelope.result.totalBytesFreed,
      'gc should report reclaimed bytes for the removed session directory',
    ).toBeGreaterThan(0);

    const listAfterGcResult = runCli(['list', '--all', '--json'], {
      AGENT_TTY_HOME: testHome,
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

  it('destroy --force records a running session as destroyed without waiting for its socket', async () => {
    const sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
    const running = inspectSession(testHome, sessionId);
    expect(running.status).toBe('running');

    const startedAt = Date.now();
    const result = runCli(['destroy', sessionId, '--force', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const destroyed = inspectSession(testHome, sessionId);
    expect(destroyed.status).toBe('destroyed');
    expect(destroyed.failureOrigin).toBeUndefined();
    expect(destroyed.failureReason).toBeUndefined();
    expect(isProcessAlive(running.hostPid)).toBe(false);
    expect(isProcessAlive(running.childPid)).toBe(false);
    await expect(
      stat(socketPath(sessionDir(testHome, sessionId))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(elapsedMs).toBeLessThan(4_500);
  });

  it('destroy records a session whose host crashed as destroyed', () => {
    const sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
    crashSession(testHome, sessionId);

    const result = runCli(['destroy', sessionId, '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    expect(inspectSession(testHome, sessionId).status).toBe('destroyed');
  });

  describe('a program that ignores SIGHUP', () => {
    let pgid = 0;

    afterEach(() => {
      if (pgid > 1) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // the group is already gone
        }
      }
      pgid = 0;
    });

    // The PTY child leads its own process group, so the group id is its pid.
    // `script` touches "$0" once its traps are set.
    async function createProgram(
      script: string,
      env: Record<string, string> = {},
    ): Promise<string> {
      const ready = join(testHome, 'program-ready');
      const sessionId = createSession(
        testHome,
        ['/bin/sh', '-c', script, ready],
        { env },
      );
      const childPid = inspectSession(testHome, sessionId).childPid;
      expect(childPid).toBeTypeOf('number');
      pgid = childPid as number;
      const deadline = Date.now() + 10_000;
      while (
        !(await stat(ready).then(
          () => true,
          () => false,
        ))
      ) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(50);
      }
      expect(isGroupAlive(pgid)).toBe(true);
      return sessionId;
    }

    it('destroy ends it within the destroy wait', async () => {
      const sessionId = await createProgram(
        'trap "" TERM HUP; touch "$0"; exec sleep 300',
      );

      const result = runCli(['destroy', sessionId, '--json'], {
        AGENT_TTY_HOME: testHome,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
      expect(result.status).toBe(0);
      expect(inspectSession(testHome, sessionId).status).toBe('destroyed');
      expect(await groupEnds(pgid)).toBe(true);
    });

    it('destroy --force ends a background process of the program', async () => {
      const sessionId = await createProgram(
        'trap "" TERM HUP; sleep 300 & touch "$0"; wait',
      );

      const result = runCli(['destroy', sessionId, '--force', '--json'], {
        AGENT_TTY_HOME: testHome,
      });
      expect(result.status).toBe(0);
      // destroy --force returns only after the whole group is gone.
      expect(isGroupAlive(pgid)).toBe(false);
      expect(inspectSession(testHome, sessionId).status).toBe('destroyed');
    });

    it('destroy ends a background process that outlives the program', async () => {
      const sessionId = await createProgram(
        '(trap "" HUP; touch "$0"; exec sleep 300) & wait',
      );

      const result = runCli(['destroy', sessionId, '--json'], {
        AGENT_TTY_HOME: testHome,
      });
      expect(result.status).toBe(0);
      expect(inspectSession(testHome, sessionId).status).toBe('destroyed');
      expect(await groupEnds(pgid)).toBe(true);
    });

    it('a reconcile after a host crash ends the program and its background process', async () => {
      const sessionId = await createProgram(
        'trap "" TERM HUP; sleep 300 & touch "$0"; wait',
      );
      crashSession(testHome, sessionId);
      await sleep(500);
      expect(isGroupAlive(pgid)).toBe(true);

      expect(inspectSession(testHome, sessionId).status).toBe('failed');
      expect(await groupEnds(pgid)).toBe(true);
    });

    describe('whose process group refuses the kill', () => {
      const refusesGroupKill = {
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS ?? '',
          `--import=${pathToFileURL(resolve('test/fixtures/eperm-group-kill.ts')).href}`,
        ].join(' '),
      };

      function destroyRefused(sessionId: string, ...flags: string[]) {
        const result = runCli(['destroy', sessionId, ...flags, '--json'], {
          ...refusesGroupKill,
          AGENT_TTY_HOME: testHome,
        });
        return {
          status: result.status,
          stderr: result.stderr,
          envelope: JSON.parse(result.stdout) as ErrorEnvelope,
        };
      }

      async function readManifestFile(sessionId: string) {
        return SessionRecordSchema.parse(
          JSON.parse(
            await readFile(
              join(testHome, 'sessions', sessionId, 'session.json'),
              'utf8',
            ),
          ) as unknown,
        );
      }

      it('destroy times out and the host survives its kill timer', async () => {
        const sessionId = await createProgram(
          'trap "" TERM HUP; touch "$0"; exec sleep 300',
          refusesGroupKill,
        );
        const { hostPid } = inspectSession(testHome, sessionId);

        const result = destroyRefused(sessionId);
        expect(result.envelope).toMatchObject({
          ok: false,
          error: { code: 'HOST_TIMEOUT' },
        });
        expect(result.status).toBe(5);
        expect(result.stderr).toBe('');
        expect(isProcessAlive(hostPid)).toBe(true);
        expect(await readManifestFile(sessionId)).toMatchObject({
          status: 'destroying',
          childPid: pgid,
        });
      });

      it('destroy times out when a background process outlives the program', async () => {
        const sessionId = await createProgram(
          '(trap "" HUP; touch "$0"; exec sleep 300) & wait',
          refusesGroupKill,
        );
        const { hostPid } = inspectSession(testHome, sessionId);

        const result = destroyRefused(sessionId);
        expect(result.envelope).toMatchObject({
          ok: false,
          error: { code: 'HOST_TIMEOUT' },
        });
        expect(result.status).toBe(5);
        expect(result.stderr).toBe('');
        const deadline = Date.now() + 10_000;
        while (isProcessAlive(hostPid)) {
          expect(Date.now()).toBeLessThan(deadline);
          await sleep(100);
        }
        expect(await readManifestFile(sessionId)).toMatchObject({
          status: 'destroying',
          childPid: pgid,
        });
      }, 60_000);

      it('destroy --force times out without recording destroyed', async () => {
        const sessionId = await createProgram(
          'trap "" TERM HUP; touch "$0"; exec sleep 300',
        );

        const result = destroyRefused(sessionId, '--force');
        expect(result.envelope).toMatchObject({
          ok: false,
          error: { code: 'HOST_TIMEOUT' },
        });
        expect(result.status).toBe(5);
        expect(result.stderr).toBe('');
        const manifest = await readManifestFile(sessionId);
        expect(manifest.status).not.toBe('destroyed');
        expect(manifest.childPid).toBe(pgid);
      });

      it('a reconcile after a host crash keeps the manifest', async () => {
        const sessionId = await createProgram(
          'trap "" TERM HUP; touch "$0"; exec sleep 300',
        );
        crashSession(testHome, sessionId);

        const result = destroyRefused(sessionId);
        expect(result.envelope).toMatchObject({
          ok: false,
          error: { code: 'HOST_UNREACHABLE' },
        });
        expect(result.status).toBe(6);
        expect(result.stderr).toBe('');
        expect(await readManifestFile(sessionId)).toMatchObject({
          status: 'running',
          childPid: pgid,
        });
      });
    });
  });

  describe('destroy run by the program itself', () => {
    let pgid = 0;

    afterEach(() => {
      if (pgid > 1) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // the group is already gone
        }
      }
      pgid = 0;
    });

    const cli = [
      process.execPath,
      '--import',
      resolve('node_modules/tsx/dist/loader.mjs'),
      resolve('src/cli/main.ts'),
    ];

    async function readEnvelopeOnceWritten(path: string): Promise<unknown> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await sleep(100);
        try {
          return JSON.parse(await readFile(path, 'utf8')) as unknown;
        } catch {
          // not written yet
        }
      }
      return undefined;
    }

    it.each([
      ['destroy', ''],
      ['destroy --force', '--force'],
    ])('%s prints its result and ends the group', async (_name, flag) => {
      const go = join(testHome, 'go');
      const sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        `while [ ! -e "$0" ]; do sleep 0.1; done; "$@" destroy "$AGENT_TTY_SESSION_ID" ${flag} --json > "$0.json"; sleep 300`,
        go,
        ...cli,
      ]);
      pgid = inspectSession(testHome, sessionId).childPid as number;
      await writeFile(go, '');

      expect(await readEnvelopeOnceWritten(`${go}.json`)).toMatchObject({
        ok: true,
        result: { sessionId, destroyed: true },
      });
      expect(inspectSession(testHome, sessionId).status).toBe('destroyed');
      expect(await groupEnds(pgid)).toBe(true);
    });

    // The program can run destroy before the host's start-up write names its
    // pid. Holding that write keeps create's manifest, with no childPid, for
    // the whole destroy. The hold matches the host's argv only, so the inner
    // CLI, which inherits it, runs at full speed.
    it('destroy --force before the host names the program prints its result', async () => {
      const out = join(testHome, 'early-destroy.json');
      runCli(
        [
          'create',
          '--json',
          '--',
          '/bin/sh',
          '-c',
          '"$@" destroy "$AGENT_TTY_SESSION_ID" --force --json > "$0"',
          out,
          ...cli,
        ],
        {
          AGENT_TTY_HOME: testHome,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS ?? '',
            `--import=${pathToFileURL(resolve('.agents/skills/verify-session-lifecycle/scripts/replay-hold.mjs')).href}`,
          ].join(' '),
          REPLAY_HOLD: '_host:rename:/session.json:1:4000',
        },
      );
      const [sessionId] = await readdir(join(testHome, 'sessions'));

      expect(await readEnvelopeOnceWritten(out)).toMatchObject({
        ok: true,
        result: { sessionId, destroyed: true },
      });
      expect(inspectSession(testHome, sessionId as string).status).toBe(
        'destroyed',
      );
    }, 60_000);

    // Bash runs a typed command as a job in its own process group, so only
    // the session id shows that it runs inside the program. destroy reads
    // that id on Linux only.
    it.runIf(process.platform === 'linux').each([
      ['destroy', ''],
      ['destroy --force', '--force'],
    ])(
      '%s typed into an interactive shell prints its result',
      async (_name, flag) => {
        const out = join(testHome, 'inner-destroy.json');
        const sessionId = createSession(
          testHome,
          ['/bin/bash', '--norc', '--noprofile', '-i'],
          { env: { HISTFILE: '/dev/null' } },
        );
        pgid = inspectSession(testHome, sessionId).childPid as number;
        const command = `${cli.map((part) => `'${part}'`).join(' ')} destroy "$AGENT_TTY_SESSION_ID" ${flag} --json > '${out}'`;
        for (const args of [
          ['type', sessionId, command],
          ['send-keys', sessionId, 'Enter'],
        ]) {
          expect(
            runCli([...args, '--json'], { AGENT_TTY_HOME: testHome }).status,
          ).toBe(0);
        }

        expect(await readEnvelopeOnceWritten(out)).toMatchObject({
          ok: true,
          result: { sessionId, destroyed: true },
        });
        expect(inspectSession(testHome, sessionId).status).toBe('destroyed');
        expect(await groupEnds(pgid)).toBe(true);
      },
    );
  });

  it('destroyed session rejects commands with SESSION_ALREADY_DESTROYED', () => {
    const sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);

    destroySession(testHome, sessionId);

    const session = inspectSession(testHome, sessionId);
    expect(session.status).toBe('destroyed');

    const typeResult = runCli(['type', sessionId, 'hello', '--json'], {
      AGENT_TTY_HOME: testHome,
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
        AGENT_TTY_HOME: testHome,
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
      AGENT_TTY_HOME: testHome,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('send-keys to non-existent session returns SESSION_NOT_FOUND', () => {
    const result = runCli(['send-keys', 'NONEXISTENT', 'Enter', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('destroy non-existent session returns SESSION_NOT_FOUND', () => {
    const result = runCli(['destroy', 'NONEXISTENT', '--json'], {
      AGENT_TTY_HOME: testHome,
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
      { AGENT_TTY_HOME: testHome },
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
      AGENT_TTY_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
  });
});
