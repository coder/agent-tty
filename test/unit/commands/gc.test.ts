import { afterEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  gcSessions,
  parseDurationToMs,
  runGcCommand,
  type GcDependencies,
  type GcResult,
  type GcSessionSweep,
} from '../../../src/cli/commands/gc.js';
import type { CommandContext } from '../../../src/cli/context.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';
import { createLogger } from '../../../src/util/logger.js';

interface MockDirectoryNode {
  kind: 'dir';
  size: number;
  entries: string[];
}

interface MockFileNode {
  kind: 'file';
  size: number;
}

type MockNode = MockDirectoryNode | MockFileNode;

interface MockSessionState {
  manifest: SessionRecord | null;
  manifestReads?: Array<SessionRecord | null>;
  reconciledManifest?: SessionRecord | null;
  isDirectory?: boolean;
}

function createSessionRecord(options: {
  sessionId: string;
  status: 'running' | 'exiting' | 'exited';
  createdAt: string;
}): SessionRecord {
  const exited = options.status === 'exited';

  return {
    version: 1,
    sessionId: options.sessionId,
    createdAt: options.createdAt,
    updatedAt: '2026-03-21T11:00:00.000Z',
    status: options.status,
    command: ['/bin/sh', '-c', 'echo ready'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: exited ? null : 123,
    childPid: exited ? null : 456,
    exitCode: exited ? 0 : null,
    exitSignal: null,
  };
}

function createNodeError(
  code: string,
  message: string,
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function createMockDependencies(
  home: string,
  sessions: Record<string, MockSessionState>,
): {
  dependencies: GcDependencies;
  removedPaths: string[];
  bytesBySession: Map<string, number>;
} {
  const sessionsRoot = `${home}/sessions`;
  const nodes = new Map<string, MockNode>();
  const manifestStore = new Map<string, SessionRecord | null>();
  const manifestReadSequences = new Map<string, Array<SessionRecord | null>>();
  const reconcileStore = new Map<string, SessionRecord | null | undefined>();
  const removedPaths: string[] = [];
  const bytesBySession = new Map<string, number>();
  const sessionIds = Object.keys(sessions);

  nodes.set(sessionsRoot, {
    kind: 'dir',
    size: 1,
    entries: sessionIds,
  });

  for (const [sessionId, sessionState] of Object.entries(sessions)) {
    const sessionDirectory = `${sessionsRoot}/${sessionId}`;
    const manifestFile = `${sessionDirectory}/session.json`;
    const artifactsDirectory = `${sessionDirectory}/artifacts`;
    const artifactFile = `${artifactsDirectory}/capture.txt`;
    const eventsFile = `${sessionDirectory}/events.jsonl`;

    if (sessionState.isDirectory === false) {
      nodes.set(sessionDirectory, {
        kind: 'file',
        size: 7,
      });
      continue;
    }

    nodes.set(sessionDirectory, {
      kind: 'dir',
      size: 4,
      entries: ['session.json', 'events.jsonl', 'artifacts'],
    });
    nodes.set(manifestFile, {
      kind: 'file',
      size: 20,
    });
    nodes.set(eventsFile, {
      kind: 'file',
      size: 30,
    });
    nodes.set(artifactsDirectory, {
      kind: 'dir',
      size: 3,
      entries: ['capture.txt'],
    });
    nodes.set(artifactFile, {
      kind: 'file',
      size: 40,
    });
    bytesBySession.set(sessionId, 97);
    if (sessionState.manifestReads !== undefined) {
      manifestReadSequences.set(manifestFile, [...sessionState.manifestReads]);
    }
    manifestStore.set(manifestFile, sessionState.manifest);
    if ('reconciledManifest' in sessionState) {
      reconcileStore.set(sessionDirectory, sessionState.reconciledManifest);
    }
  }

  const dependencies: GcDependencies = {
    now: () => new Date('2026-03-21T12:00:00.000Z'),
    readdir: (path: string) => {
      const node = nodes.get(path);
      if (node === undefined) {
        return Promise.reject(
          createNodeError('ENOENT', `Missing path: ${path}`),
        );
      }
      if (node.kind !== 'dir') {
        return Promise.reject(
          createNodeError('ENOTDIR', `Not a directory: ${path}`),
        );
      }
      return Promise.resolve([...node.entries]);
    },
    stat: (path: string) => {
      const node = nodes.get(path);
      if (node === undefined) {
        return Promise.reject(
          createNodeError('ENOENT', `Missing path: ${path}`),
        );
      }
      return Promise.resolve({
        size: node.size,
        isDirectory: () => node.kind === 'dir',
      });
    },
    rm: (path: string) => {
      removedPaths.push(path);
      return Promise.resolve();
    },
    readManifestIfExists: (path: string) => {
      const manifestReadSequence = manifestReadSequences.get(path);
      if (
        manifestReadSequence !== undefined &&
        manifestReadSequence.length > 0
      ) {
        return Promise.resolve(manifestReadSequence.shift() ?? null);
      }

      return Promise.resolve(
        manifestStore.has(path) ? (manifestStore.get(path) ?? null) : null,
      );
    },
    reconcileSession: (sessionDirectory: string) => {
      if (reconcileStore.has(sessionDirectory)) {
        manifestStore.set(
          `${sessionDirectory}/session.json`,
          reconcileStore.get(sessionDirectory) ?? null,
        );
      }
      return Promise.resolve();
    },
  };

  return {
    dependencies,
    removedPaths,
    bytesBySession,
  };
}

describe('gc command helpers', () => {
  it('parses supported duration formats', () => {
    expect(parseDurationToMs('30m')).toBe(30 * 60_000);
    expect(parseDurationToMs('1h')).toBe(60 * 60_000);
    expect(parseDurationToMs('7d')).toBe(7 * 24 * 60 * 60_000);
    expect(parseDurationToMs('24h')).toBe(24 * 60 * 60_000);
  });

  it('rejects invalid duration formats', () => {
    for (const value of ['0m', '15', '1w', 'h', '30mm']) {
      try {
        parseDurationToMs(value);
        throw new Error(`Expected ${value} to throw`);
      } catch (error) {
        expect(error).toMatchObject({
          code: ERROR_CODES.INVALID_DURATION,
        });
      }
    }
  });

  it('removes exited sessions and never deletes running sessions', async () => {
    const home = '/tmp/agent-tty';
    const { dependencies, removedPaths, bytesBySession } =
      createMockDependencies(home, {
        'exited-01': {
          manifest: createSessionRecord({
            sessionId: 'exited-01',
            status: 'exited',
            createdAt: '2026-03-20T08:00:00.000Z',
          }),
        },
        'running-01': {
          manifest: createSessionRecord({
            sessionId: 'running-01',
            status: 'running',
            createdAt: '2026-03-20T09:00:00.000Z',
          }),
        },
      });

    const result = await gcSessions(
      home,
      {
        dryRun: false,
        staleOnly: false,
        olderThanMs: null,
      },
      dependencies,
    );

    expect(result).toEqual({
      removedSessions: ['exited-01'],
      skippedSessions: [
        {
          sessionId: 'running-01',
          reason: 'session host is still alive',
        },
      ],
      dryRun: false,
      totalBytesFreed: bytesBySession.get('exited-01'),
    });
    expect(removedPaths).toEqual([`${home}/sessions/exited-01`]);
  });

  it('skips deleting a session that restarts after the exited check', async () => {
    const home = '/tmp/agent-tty';
    const exitedManifest = createSessionRecord({
      sessionId: 'race-01',
      status: 'exited',
      createdAt: '2026-03-20T08:00:00.000Z',
    });
    const restartedManifest = createSessionRecord({
      sessionId: 'race-01',
      status: 'running',
      createdAt: '2026-03-20T08:00:00.000Z',
    });
    const { dependencies, removedPaths } = createMockDependencies(home, {
      'race-01': {
        manifest: exitedManifest,
        manifestReads: [exitedManifest, exitedManifest, restartedManifest],
      },
    });

    const result = await gcSessions(
      home,
      {
        dryRun: false,
        staleOnly: false,
        olderThanMs: null,
      },
      dependencies,
    );

    expect(result).toEqual({
      removedSessions: [],
      skippedSessions: [
        {
          sessionId: 'race-01',
          reason: 'session restarted between check and delete',
        },
      ],
      dryRun: false,
      totalBytesFreed: 0,
    });
    expect(removedPaths).toEqual([]);
  });

  it('reports removals in dry-run mode without deleting anything', async () => {
    const home = '/tmp/agent-tty';
    const { dependencies, removedPaths, bytesBySession } =
      createMockDependencies(home, {
        'exited-01': {
          manifest: createSessionRecord({
            sessionId: 'exited-01',
            status: 'exited',
            createdAt: '2026-03-20T08:00:00.000Z',
          }),
        },
      });

    const result = await gcSessions(
      home,
      {
        dryRun: true,
        staleOnly: false,
        olderThanMs: null,
      },
      dependencies,
    );

    expect(result).toEqual({
      removedSessions: ['exited-01'],
      skippedSessions: [],
      dryRun: true,
      totalBytesFreed: bytesBySession.get('exited-01'),
    });
    expect(removedPaths).toEqual([]);
  });

  it('filters removals by age threshold', async () => {
    const home = '/tmp/agent-tty';
    const { dependencies } = createMockDependencies(home, {
      'old-exited': {
        manifest: createSessionRecord({
          sessionId: 'old-exited',
          status: 'exited',
          createdAt: '2026-03-21T08:00:00.000Z',
        }),
      },
      'fresh-exited': {
        manifest: createSessionRecord({
          sessionId: 'fresh-exited',
          status: 'exited',
          createdAt: '2026-03-21T11:30:00.000Z',
        }),
      },
    });

    const result = await gcSessions(
      home,
      {
        dryRun: false,
        staleOnly: false,
        olderThanMs: 60 * 60_000,
      },
      dependencies,
    );

    expect(result.removedSessions).toEqual(['old-exited']);
    expect(result.skippedSessions).toEqual([
      {
        sessionId: 'fresh-exited',
        reason: 'session is newer than the requested age threshold',
      },
    ]);
  });

  it('handles rm failure gracefully and continues with other sessions', async () => {
    const home = '/tmp/agent-tty';
    const { dependencies, removedPaths, bytesBySession } =
      createMockDependencies(home, {
        'failed-01': {
          manifest: createSessionRecord({
            sessionId: 'failed-01',
            status: 'exited',
            createdAt: '2026-03-20T08:00:00.000Z',
          }),
        },
        'exited-02': {
          manifest: createSessionRecord({
            sessionId: 'exited-02',
            status: 'exited',
            createdAt: '2026-03-20T09:00:00.000Z',
          }),
        },
      });
    const removeError = createNodeError('EACCES', 'permission denied');
    const originalRm = dependencies.rm;
    dependencies.rm = (path, options) => {
      if (path === `${home}/sessions/failed-01`) {
        return Promise.reject(removeError);
      }
      return originalRm(path, options);
    };

    const result = await gcSessions(
      home,
      {
        dryRun: false,
        staleOnly: false,
        olderThanMs: null,
      },
      dependencies,
    );

    expect(result).toEqual({
      removedSessions: ['exited-02'],
      skippedSessions: [
        {
          sessionId: 'failed-01',
          reason: 'failed to remove session directory: permission denied',
        },
      ],
      dryRun: false,
      totalBytesFreed: bytesBySession.get('exited-02'),
    });
    expect(removedPaths).toEqual([`${home}/sessions/exited-02`]);
  });

  it('only targets stale sessions when --stale-only is used', async () => {
    const home = '/tmp/agent-tty';
    const staleBefore = createSessionRecord({
      sessionId: 'stale-01',
      status: 'running',
      createdAt: '2026-03-19T09:00:00.000Z',
    });
    const staleAfter: SessionRecord = {
      ...staleBefore,
      status: 'exited',
      updatedAt: '2026-03-21T11:59:00.000Z',
      hostPid: null,
      childPid: null,
      exitCode: 137,
    };

    const { dependencies, removedPaths } = createMockDependencies(home, {
      'stale-01': {
        manifest: staleBefore,
        reconciledManifest: staleAfter,
      },
      'exited-01': {
        manifest: createSessionRecord({
          sessionId: 'exited-01',
          status: 'exited',
          createdAt: '2026-03-19T08:00:00.000Z',
        }),
      },
      'running-01': {
        manifest: createSessionRecord({
          sessionId: 'running-01',
          status: 'running',
          createdAt: '2026-03-19T10:00:00.000Z',
        }),
      },
    });

    const result = await gcSessions(
      home,
      {
        dryRun: false,
        staleOnly: true,
        olderThanMs: null,
      },
      dependencies,
    );

    expect(result.removedSessions).toEqual(['stale-01']);
    expect(result.skippedSessions).toEqual([
      {
        sessionId: 'exited-01',
        reason: 'session is not stale',
      },
      {
        sessionId: 'running-01',
        reason: 'session host is still alive',
      },
    ]);
    expect(removedPaths).toEqual([`${home}/sessions/stale-01`]);
  });
});

describe('runGcCommand (cross-Home sweep)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function gcContext(home: string, explicitHome: boolean): CommandContext {
    return {
      home,
      explicitHome,
      timeoutMs: undefined,
      colorEnabled: true,
      logLevel: 'info',
      logger: createLogger('info', () => undefined),
      profileDefault: undefined,
      rendererDefault: 'ghostty-web',
      configFile: null,
    } as const;
  }

  const emptySweep: GcSessionSweep = {
    removedSessions: [],
    skippedSessions: [],
    dryRun: false,
    totalBytesFreed: 0,
  };

  function captureEnvelopeResult(): () => GcResult {
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    return () => {
      const calls = spy.mock.calls as unknown[][];
      const last = calls.at(-1)?.[0];
      if (typeof last !== 'string') {
        throw new Error('expected an emitted gc envelope');
      }
      return (JSON.parse(last) as { result: GcResult }).result;
    };
  }

  it('scopes to a single Home and never touches the registry when explicit', async () => {
    const readRegistry = vi.fn(() =>
      Promise.resolve([{ path: '/registered' }]),
    );
    const forgetHome = vi.fn(() => Promise.resolve());
    const sweepHome = vi.fn(() =>
      Promise.resolve({
        ...emptySweep,
        removedSessions: ['s1'],
        totalBytesFreed: 10,
      }),
    );
    const readResult = captureEnvelopeResult();

    await runGcCommand(
      {
        context: gcContext('/h/explicit', true),
        json: true,
        dryRun: false,
        staleOnly: false,
        olderThan: undefined,
      },
      {
        sweepHome,
        readRegistry,
        forgetHome,
        homeExists: () => Promise.resolve(true),
        homeHasSessions: () => Promise.resolve(true),
      },
    );

    expect(readRegistry).not.toHaveBeenCalled();
    expect(forgetHome).not.toHaveBeenCalled();
    const result = readResult();
    expect(result.homes.map((home) => home.home)).toEqual(['/h/explicit']);
    expect(result.removedSessionCount).toBe(1);
    expect(result.totalBytesFreed).toBe(10);
    expect(result.deregisteredHomes).toEqual([]);
  });

  it('sweeps registered Homes and deregisters emptied or gone ones', async () => {
    const forgetHome = vi.fn((_home: string) => Promise.resolve());
    const sweepHome = vi.fn(() => Promise.resolve(emptySweep));
    const readResult = captureEnvelopeResult();

    await runGcCommand(
      {
        context: gcContext('/h/default', false),
        json: true,
        dryRun: false,
        staleOnly: false,
        olderThan: undefined,
      },
      {
        sweepHome,
        readRegistry: () =>
          Promise.resolve([
            { path: '/h/default' },
            { path: '/h/empty' },
            { path: '/h/gone' },
          ]),
        forgetHome,
        homeExists: (home) => Promise.resolve(home !== '/h/gone'),
        homeHasSessions: (home) => Promise.resolve(home === '/h/default'),
      },
    );

    // /h/empty (emptied) and /h/gone (directory gone) are deregistered;
    // /h/default still has Sessions, so it stays registered.
    expect(forgetHome.mock.calls.map((call) => call[0]).sort()).toEqual([
      '/h/empty',
      '/h/gone',
    ]);
    const result = readResult();
    expect(result.homes.map((home) => home.home)).toEqual([
      '/h/default',
      '/h/empty',
      '/h/gone',
    ]);
    expect([...result.deregisteredHomes].sort()).toEqual([
      '/h/empty',
      '/h/gone',
    ]);
  });

  it('dry-run never deregisters an emptied Home, only already-gone ones', async () => {
    const forgetHome = vi.fn(() => Promise.resolve());
    const readResult = captureEnvelopeResult();

    await runGcCommand(
      {
        context: gcContext('/h/default', false),
        json: true,
        dryRun: true,
        staleOnly: false,
        olderThan: undefined,
      },
      {
        sweepHome: () => Promise.resolve({ ...emptySweep, dryRun: true }),
        readRegistry: () =>
          Promise.resolve([{ path: '/h/gone' }, { path: '/h/empty' }]),
        forgetHome,
        homeExists: (home) => Promise.resolve(home !== '/h/gone'),
        // dry-run removed nothing, so a populated Home still reports Sessions.
        homeHasSessions: () => Promise.resolve(true),
      },
    );

    // No registry writes under --dry-run.
    expect(forgetHome).not.toHaveBeenCalled();
    // Only the already-gone Home is reported as a would-deregister.
    expect(readResult().deregisteredHomes).toEqual(['/h/gone']);
  });
});
