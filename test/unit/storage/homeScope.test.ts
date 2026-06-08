import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listRegisteredHomes,
  scanHome,
  type HomeSessionCounts,
  type ScanHomeDependencies,
} from '../../../src/storage/homeScope.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';
import { readManifest, writeManifest } from '../../../src/storage/manifests.js';
import { manifestPath, sessionDir } from '../../../src/storage/sessionPaths.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function makeRecord(
  overrides: Partial<SessionRecord> & { sessionId: string },
): SessionRecord {
  return {
    version: 1,
    createdAt: '2026-06-02T12:00:00.000Z',
    updatedAt: '2026-06-02T12:00:00.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: null,
    childPid: null,
    exitCode: null,
    exitSignal: null,
    ...overrides,
  };
}

describe('scanHome (read-only Session counts)', () => {
  let home = '';

  beforeEach(async () => {
    home = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-homescope-')),
    );
    temporaryDirectories.push(home);
  });

  async function seedSession(
    record: Partial<SessionRecord> & { sessionId: string },
  ): Promise<void> {
    const dir = sessionDir(home, record.sessionId);
    await mkdir(dir, { recursive: true });
    await writeManifest(manifestPath(dir), makeRecord(record));
  }

  it('counts active and visible (non-destroyed) Sessions', async () => {
    await seedSession({ sessionId: 'running-1', status: 'running' });
    await seedSession({ sessionId: 'exited-1', status: 'exited' });
    await seedSession({ sessionId: 'destroyed-1', status: 'destroyed' });

    expect(await scanHome(home)).toEqual({
      activeSessions: 1,
      totalSessions: 2,
    });
  });

  it('treats a missing Home as having no Sessions', async () => {
    expect(await scanHome(join(home, 'does-not-exist'))).toEqual({
      activeSessions: 0,
      totalSessions: 0,
    });
  });

  it('NEVER reconciles: a running Session with a dead host stays running', async () => {
    // hostPid that is essentially never alive. listSessions WOULD reconcile this
    // to `failed`; scanHome must not — listing must never mutate Session state.
    await seedSession({
      sessionId: 'dead-host',
      status: 'running',
      hostPid: 2_147_483_646,
      childPid: 2_147_483_645,
    });
    const before = await readManifest(
      manifestPath(sessionDir(home, 'dead-host')),
    );

    const counts = await scanHome(home);

    expect(counts).toEqual({ activeSessions: 1, totalSessions: 1 });
    const after = await readManifest(
      manifestPath(sessionDir(home, 'dead-host')),
    );
    // Byte-for-byte unchanged — no reconcile, no rewrite.
    expect(after).toEqual(before);
    expect(after.status).toBe('running');
  });

  it('skips a Session whose manifest fails to read and counts the rest', async () => {
    // A single corrupt/unreadable manifest must not break discovery of the Home.
    const dependencies: ScanHomeDependencies = {
      readdir: () => Promise.resolve(['corrupt', 'good']),
      readManifestIfExists: (path) =>
        path.includes('corrupt')
          ? Promise.reject(new Error('manifest is unreadable'))
          : Promise.resolve(
              makeRecord({ sessionId: 'good', status: 'running' }),
            ),
    };

    expect(await scanHome('/fake/home', dependencies)).toEqual({
      activeSessions: 1,
      totalSessions: 1,
    });
  });
});

describe('listRegisteredHomes (scope, prune, ordering)', () => {
  const counts: Record<string, HomeSessionCounts> = {
    '/homes/live': { activeSessions: 2, totalSessions: 4 },
    '/homes/terminal-only': { activeSessions: 0, totalSessions: 3 },
    '/homes/empty': { activeSessions: 0, totalSessions: 0 },
  };

  function deps(scopeEntries: Array<{ path: string; lastSeenAt: string }>) {
    return {
      registry: { read: () => Promise.resolve(scopeEntries) },
      scanHome: (home: string) =>
        Promise.resolve(
          counts[home] ?? { activeSessions: 0, totalSessions: 0 },
        ),
    };
  }

  const entries = [
    { path: '/homes/live', lastSeenAt: '2026-06-03T00:00:00.000Z' },
    { path: '/homes/terminal-only', lastSeenAt: '2026-06-05T00:00:00.000Z' },
    { path: '/homes/empty', lastSeenAt: '2026-06-09T00:00:00.000Z' },
  ];

  it('active scope shows only Homes with an Active Session, newest-first', async () => {
    const homes = await listRegisteredHomes('active', deps(entries));
    expect(homes).toEqual([
      {
        path: '/homes/live',
        activeSessions: 2,
        totalSessions: 4,
        lastSeenAt: '2026-06-03T00:00:00.000Z',
      },
    ]);
  });

  it('all scope includes terminal-only Homes but still prunes empty ones', async () => {
    const homes = await listRegisteredHomes('all', deps(entries));
    // newest-first: terminal-only (06-05) before live (06-03); empty pruned.
    expect(homes.map((home) => home.path)).toEqual([
      '/homes/terminal-only',
      '/homes/live',
    ]);
  });

  it('prune-on-read omits a Home with zero visible Sessions in both scopes', async () => {
    const onlyEmpty = [
      { path: '/homes/empty', lastSeenAt: '2026-06-09T00:00:00.000Z' },
    ];
    expect(await listRegisteredHomes('active', deps(onlyEmpty))).toEqual([]);
    expect(await listRegisteredHomes('all', deps(onlyEmpty))).toEqual([]);
  });
});
