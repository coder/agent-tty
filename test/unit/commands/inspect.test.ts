import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, makeCliError } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  computeArtifactHealth: vi.fn(),
  countEventLogEntries: vi.fn(),
  statEventLogBytes: vi.fn(),
  deriveTerminationCategory: vi.fn(),
  emitSuccess: vi.fn(),
  reconcileSession: vi.fn(),
  sendRpc: vi.fn(),
  readManifest: vi.fn(),
  readManifestIfExists: vi.fn(),
  sessionDir: vi.fn(),
  eventLogPath: vi.fn(),
  manifestPath: vi.fn(),
  socketPath: vi.fn(),
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/eventLog.js', () => ({
  countEventLogEntries: mocks.countEventLogEntries,
  statEventLogBytes: mocks.statEventLogBytes,
}));

vi.mock('../../../src/host/lifecycle.js', () => ({
  reconcileSession: mocks.reconcileSession,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/protocol/terminationCategory.js', () => ({
  deriveTerminationCategory: mocks.deriveTerminationCategory,
}));

vi.mock('../../../src/storage/artifactHealth.js', () => ({
  computeArtifactHealth: mocks.computeArtifactHealth,
}));

vi.mock('../../../src/storage/manifests.js', () => ({
  readManifest: mocks.readManifest,
  readManifestIfExists: mocks.readManifestIfExists,
}));

vi.mock('../../../src/storage/sessionPaths.js', () => ({
  sessionDir: mocks.sessionDir,
  eventLogPath: mocks.eventLogPath,
  manifestPath: mocks.manifestPath,
  socketPath: mocks.socketPath,
}));

import { runInspectCommand } from '../../../src/cli/commands/inspect.js';
import type { SessionStatus } from '../../../src/protocol/schemas.js';
import { createLogger } from '../../../src/util/logger.js';

const TEST_CONTEXT = {
  home: '/tmp/agent-tty',
  timeoutMs: undefined,
  colorEnabled: true,
  logLevel: 'info',
  logger: createLogger('info', () => undefined),
  profileDefault: undefined,
  rendererDefault: 'ghostty-web',
  configFile: null,
} as const;

const DEFAULT_ARTIFACT_HEALTH = {
  total: 2,
  byKind: {
    snapshot: 1,
    screenshot: 1,
  },
  missingCount: 0,
  health: 'healthy' as const,
};

function getLastEmitSuccessPayload(): unknown {
  return mocks.emitSuccess.mock.calls.at(-1)?.[0] as unknown;
}

function createSessionRecord(status: SessionStatus = 'running') {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status,
    ...(status === 'failed'
      ? {
          failureOrigin: 'host-death' as const,
          failureReason: 'host exited unexpectedly',
        }
      : {}),
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: status === 'running' || status === 'exiting' ? 123 : null,
    childPid: status === 'running' || status === 'exiting' ? 456 : null,
    exitCode: status === 'exited' ? 0 : null,
    exitSignal: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inspect command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionDir.mockImplementation(
      (_home: string, sessionId: string) =>
        `/tmp/agent-tty/sessions/${sessionId}`,
    );
    mocks.manifestPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/session.json`,
    );
    mocks.eventLogPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/events.jsonl`,
    );
    mocks.socketPath.mockImplementation(
      (sessionDirectory: string) => `${sessionDirectory}/rpc.sock`,
    );
    mocks.computeArtifactHealth.mockResolvedValue(DEFAULT_ARTIFACT_HEALTH);
    mocks.countEventLogEntries.mockResolvedValue(2);
    mocks.statEventLogBytes.mockResolvedValue(undefined);
    mocks.deriveTerminationCategory.mockReturnValue('running');
    mocks.readManifestIfExists.mockResolvedValue(
      createSessionRecord('running'),
    );
    mocks.readManifest.mockResolvedValue(createSessionRecord('exited'));
    mocks.reconcileSession.mockResolvedValue(undefined);
  });

  it('uses live RPC inspect data when the session is active', async () => {
    const liveSession = createSessionRecord('running');
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse('2026-03-19T12:00:05.000Z'),
    );
    mocks.sendRpc.mockResolvedValue({ session: liveSession });
    mocks.deriveTerminationCategory.mockReturnValue('running');

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'inspect',
    );
    expect(mocks.countEventLogEntries).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/events.jsonl',
    );
    expect(mocks.computeArtifactHealth).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01',
    );
    expect(mocks.deriveTerminationCategory).toHaveBeenCalledWith(liveSession);
    const emitted = getLastEmitSuccessPayload() as {
      command: string;
      json: boolean;
      result: {
        session: ReturnType<typeof createSessionRecord>;
        eventCount: number;
        uptime: number;
        lastEventSeq?: number;
        terminationCategory?: string;
        artifacts?: typeof DEFAULT_ARTIFACT_HEALTH;
        usedOfflineReplay?: boolean;
        rendererRuntime?: {
          backend: string;
          mode: string;
          status: string;
          reason?: string;
        };
      };
      lines: string[];
    };

    expect(emitted.command).toBe('inspect');
    expect(emitted.json).toBe(false);
    expect(emitted.result).toEqual(
      expect.objectContaining({
        session: liveSession,
        eventCount: 2,
        uptime: 5000,
        lastEventSeq: 1,
        terminationCategory: 'running',
        artifacts: DEFAULT_ARTIFACT_HEALTH,
        usedOfflineReplay: false,
        rendererRuntime: {
          backend: 'ghostty-web',
          mode: 'live-host',
          status: 'healthy',
        },
      }),
    );
    expect(emitted.lines).toEqual(
      expect.arrayContaining([
        'Event Count: 2',
        'Renderer: ghostty-web (live-host, healthy)',
        'Last Event Seq: 1',
        'Uptime: 5000ms',
        'Artifacts: 2 total (screenshot: 1, snapshot: 1), health: healthy',
      ]),
    );
    expect(emitted.lines).not.toContain('Offline Replay: yes');
    expect(emitted.lines).not.toContain('Termination: running');
  });

  it('treats exiting sessions as live-host renderer runtime', async () => {
    const exitingSession = createSessionRecord('exiting');
    mocks.readManifestIfExists.mockResolvedValueOnce(exitingSession);
    mocks.sendRpc.mockResolvedValueOnce({ session: exitingSession });
    mocks.deriveTerminationCategory.mockReturnValueOnce('running');

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/rpc.sock',
      'inspect',
    );

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        usedOfflineReplay?: boolean;
        rendererRuntime: {
          backend: string;
          mode: string;
          status: string;
          reason?: string;
        };
      };
      lines: string[];
    };

    expect(emitted.result.usedOfflineReplay).toBe(false);
    expect(emitted.result.rendererRuntime).toEqual({
      backend: 'ghostty-web',
      mode: 'live-host',
      status: 'healthy',
    });
    expect(emitted.lines).toContain(
      'Renderer: ghostty-web (live-host, healthy)',
    );
    expect(emitted.lines).not.toContain('Offline Replay: yes');
  });

  it('degrades gracefully when artifact health computation fails', async () => {
    const liveSession = createSessionRecord('running');
    mocks.computeArtifactHealth.mockRejectedValueOnce(
      new Error('EACCES: permission denied'),
    );
    mocks.sendRpc.mockResolvedValueOnce({ session: liveSession });
    mocks.countEventLogEntries.mockResolvedValueOnce(5);
    mocks.deriveTerminationCategory.mockReturnValueOnce('running');

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        session: ReturnType<typeof createSessionRecord>;
        eventCount: number;
        lastEventSeq?: number;
        terminationCategory?: string;
        artifacts?: typeof DEFAULT_ARTIFACT_HEALTH;
        rendererRuntime?: {
          backend: string;
          mode: string;
          status: string;
          reason?: string;
        };
      };
      lines: string[];
    };

    expect(emitted).toBeDefined();
    expect(emitted.result).toEqual(
      expect.objectContaining({
        session: liveSession,
        eventCount: 5,
        lastEventSeq: 4,
        terminationCategory: 'running',
        rendererRuntime: {
          backend: 'ghostty-web',
          mode: 'live-host',
          status: 'healthy',
        },
      }),
    );
    expect(emitted.result.artifacts).toBeUndefined();
    expect(emitted.lines).not.toContain(expect.stringMatching(/^Artifacts:/));
  });

  it('rejects malformed inspect RPC responses', async () => {
    mocks.sendRpc.mockResolvedValue({ session: { sessionId: 'session-01' } });

    await expect(
      runInspectCommand({
        context: TEST_CONTEXT,
        json: false,
        sessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PROTOCOL_ERROR,
      message: 'Unexpected response from host',
      details: {
        issues: expect.any(Array) as unknown,
      },
    });
    expect(mocks.emitSuccess).not.toHaveBeenCalled();
  });

  it('falls back to reconciled manifest data when the host is unreachable', async () => {
    const reconciledSession = createSessionRecord('exited');
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'Session host is unreachable.',
      }),
    );
    mocks.readManifest.mockResolvedValue(reconciledSession);
    mocks.deriveTerminationCategory.mockReturnValue('clean-exit');

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    expect(mocks.reconcileSession).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01',
    );
    expect(mocks.readManifest).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/session.json',
    );
    expect(mocks.countEventLogEntries).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01/events.jsonl',
    );
    expect(mocks.computeArtifactHealth).toHaveBeenCalledWith(
      '/tmp/agent-tty/sessions/session-01',
    );
    expect(mocks.deriveTerminationCategory).toHaveBeenCalledWith(
      reconciledSession,
    );

    const emitted = getLastEmitSuccessPayload() as {
      command: string;
      json: boolean;
      result: {
        session: ReturnType<typeof createSessionRecord>;
        eventCount: number;
        uptime: number;
        lastEventSeq?: number;
        terminationCategory?: string;
        artifacts?: typeof DEFAULT_ARTIFACT_HEALTH;
        usedOfflineReplay?: boolean;
        rendererRuntime?: {
          backend: string;
          mode: string;
          status: string;
          reason?: string;
        };
      };
      lines: string[];
    };

    expect(emitted.command).toBe('inspect');
    expect(emitted.json).toBe(true);
    expect(emitted.result).toEqual(
      expect.objectContaining({
        session: reconciledSession,
        eventCount: 2,
        uptime: 1000,
        lastEventSeq: 1,
        terminationCategory: 'clean-exit',
        artifacts: DEFAULT_ARTIFACT_HEALTH,
        usedOfflineReplay: true,
        rendererRuntime: {
          backend: 'ghostty-web',
          mode: 'offline-replay',
          status: 'fallback',
          reason: 'host-unreachable',
        },
      }),
    );
    expect(emitted.lines).toEqual(
      expect.arrayContaining([
        'Renderer: ghostty-web (offline-replay, fallback — host-unreachable)',
        'Offline Replay: yes',
        'Termination: clean-exit',
      ]),
    );
  });

  it('reports offline replay renderer runtime for exited sessions', async () => {
    const exitedSession = createSessionRecord('exited');
    mocks.readManifestIfExists.mockResolvedValueOnce(exitedSession);
    mocks.countEventLogEntries.mockResolvedValueOnce(3);
    mocks.deriveTerminationCategory.mockReturnValueOnce('clean-exit');

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).not.toHaveBeenCalled();

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        usedOfflineReplay?: boolean;
        rendererRuntime?: {
          backend: string;
          mode: string;
          status: string;
          reason?: string;
        };
      };
      lines: string[];
    };

    expect(emitted.result.usedOfflineReplay).toBe(false);
    expect(emitted.result.rendererRuntime).toEqual({
      backend: 'ghostty-web',
      mode: 'offline-replay',
      status: 'fallback',
      reason: 'session-not-running',
    });
    expect(emitted.lines).toContain(
      'Renderer: ghostty-web (offline-replay, fallback — session-not-running)',
    );
    expect(emitted.lines).not.toContain('Offline Replay: yes');
  });

  it('reports offline replay renderer runtime for destroying sessions', async () => {
    const destroyingSession = createSessionRecord('destroying');
    mocks.readManifestIfExists.mockResolvedValueOnce(destroyingSession);
    mocks.countEventLogEntries.mockResolvedValueOnce(4);
    mocks.deriveTerminationCategory.mockReturnValueOnce('destroyed');

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    expect(mocks.sendRpc).not.toHaveBeenCalled();

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        usedOfflineReplay?: boolean;
        rendererRuntime: {
          backend: string;
          mode: string;
          status: string;
          reason?: string;
        };
      };
      lines: string[];
    };

    expect(emitted.result.usedOfflineReplay).toBe(false);
    expect(emitted.result.rendererRuntime).toEqual({
      backend: 'ghostty-web',
      mode: 'offline-replay',
      status: 'fallback',
      reason: 'session-not-running',
    });
    expect(emitted.lines).toContain(
      'Renderer: ghostty-web (offline-replay, fallback — session-not-running)',
    );
    expect(emitted.lines).not.toContain('Offline Replay: yes');
  });

  it('omits last event sequence from human output when the event log is empty', async () => {
    const liveSession = createSessionRecord('running');
    mocks.countEventLogEntries.mockResolvedValue(0);
    mocks.sendRpc.mockResolvedValue({ session: liveSession });

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: false,
      sessionId: 'session-01',
    });

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        lastEventSeq?: number;
      };
      lines: string[];
    };

    expect(emitted.result.lastEventSeq).toBeUndefined();
    expect(emitted.lines).toContain('Event Count: 0');
    expect(emitted.lines).not.toContain(
      expect.stringMatching(/^Last Event Seq:/),
    );
  });

  it('surfaces host info and renderer extensions in live mode', async () => {
    const liveSession = createSessionRecord('running');
    mocks.sendRpc.mockResolvedValue({
      session: liveSession,
      cliVersion: '0.2.1',
      rpcSocketPath: '/tmp/agent-tty/sessions/session-01/rpc.sock',
      rendererProfile: 'reference-dark',
      rendererBooted: true,
      rendererBootInFlight: false,
    });

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        host?: { cliVersion: string; rpcSocketPath: string };
        rendererRuntime: {
          backend: string;
          mode: string;
          status: string;
          profile?: string;
          booted?: boolean;
          bootInFlight?: boolean;
        };
      };
      lines: string[];
    };

    expect(emitted.result.host).toEqual({
      cliVersion: '0.2.1',
      rpcSocketPath: '/tmp/agent-tty/sessions/session-01/rpc.sock',
    });
    expect(emitted.result.rendererRuntime).toEqual({
      backend: 'ghostty-web',
      mode: 'live-host',
      status: 'healthy',
      profile: 'reference-dark',
      booted: true,
      bootInFlight: false,
    });
    expect(emitted.lines).toEqual(
      expect.arrayContaining([
        'Host CLI Version: 0.2.1',
        'RPC Socket: /tmp/agent-tty/sessions/session-01/rpc.sock',
        'Renderer: ghostty-web (live-host, healthy) [profile: reference-dark, booted: yes]',
      ]),
    );
  });

  it('surfaces host.rpcSocketPath even when cliVersion is unavailable', async () => {
    // Exercises the DEREM-24 fix: when `loadPackageMetadata` fails on the
    // host, `cliVersion` is omitted from the RPC response but
    // `rpcSocketPath` is still populated. The CLI must surface the socket
    // path instead of dropping the entire `host` block.
    const liveSession = createSessionRecord('running');
    mocks.sendRpc.mockResolvedValue({
      session: liveSession,
      rpcSocketPath: '/tmp/agent-tty/sessions/session-01/rpc.sock',
      rendererBooted: false,
      rendererBootInFlight: false,
    });

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        host?: { cliVersion?: string; rpcSocketPath: string };
      };
      lines: string[];
    };

    expect(emitted.result.host).toEqual({
      rpcSocketPath: '/tmp/agent-tty/sessions/session-01/rpc.sock',
    });
    expect(emitted.result.host?.cliVersion).toBeUndefined();
    expect(emitted.lines).toContain(
      'RPC Socket: /tmp/agent-tty/sessions/session-01/rpc.sock',
    );
    expect(emitted.lines).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^Host CLI Version:/)]),
    );
  });

  it('omits host info and renderer extensions in offline-replay mode', async () => {
    const reconciledSession = createSessionRecord('exited');
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'Session host is unreachable.',
      }),
    );
    mocks.readManifest.mockResolvedValue(reconciledSession);
    mocks.deriveTerminationCategory.mockReturnValue('clean-exit');

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    const emitted = getLastEmitSuccessPayload() as {
      result: {
        host?: unknown;
        rendererRuntime: {
          backend: string;
          mode: string;
          profile?: string;
          booted?: boolean;
          bootInFlight?: boolean;
        };
      };
    };

    expect(emitted.result.host).toBeUndefined();
    expect(emitted.result.rendererRuntime.profile).toBeUndefined();
    expect(emitted.result.rendererRuntime.booted).toBeUndefined();
    expect(emitted.result.rendererRuntime.bootInFlight).toBeUndefined();
  });

  it('surfaces eventLogBytes in both live and offline modes', async () => {
    const liveSession = createSessionRecord('running');
    mocks.sendRpc.mockResolvedValue({ session: liveSession });
    mocks.statEventLogBytes.mockResolvedValue(4096);

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    const liveEmitted = getLastEmitSuccessPayload() as {
      result: { eventLogBytes?: number };
      lines: string[];
    };
    expect(liveEmitted.result.eventLogBytes).toBe(4096);
    expect(liveEmitted.lines).toContain('Event Log Bytes: 4096');

    const reconciledSession = createSessionRecord('exited');
    mocks.sendRpc.mockRejectedValue(
      makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: 'Session host is unreachable.',
      }),
    );
    mocks.readManifest.mockResolvedValue(reconciledSession);
    mocks.statEventLogBytes.mockResolvedValue(8192);

    await runInspectCommand({
      context: TEST_CONTEXT,
      json: true,
      sessionId: 'session-01',
    });

    const offlineEmitted = getLastEmitSuccessPayload() as {
      result: { eventLogBytes?: number };
    };
    expect(offlineEmitted.result.eventLogBytes).toBe(8192);
  });
});
