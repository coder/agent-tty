import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord } from '../../../src/protocol/schemas.js';
import { listDashboardSessions } from '../../../src/dashboard/sessionScope.js';
import { writeManifest } from '../../../src/storage/manifests.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
} from '../../../src/storage/sessionPaths.js';

let home = '';
let host: ChildProcess | undefined;

// Reconcile reads a hostPid as live only while it runs `_host <session id>`.
function startHost(sessionId: string): number {
  host = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '_host', sessionId, '1'],
    { stdio: 'ignore' },
  );
  expect(host.pid).toBeTypeOf('number');
  return host.pid as number;
}

async function seedSession(
  record: Partial<SessionRecord> & { sessionId: string },
): Promise<void> {
  const dir = sessionDir(home, record.sessionId);
  await mkdir(dir, { recursive: true });
  const full: SessionRecord = {
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
    ...record,
  };
  await writeManifest(manifestPath(dir), full);
  await writeFile(eventLogPath(dir), '', 'utf8');
}

describe('listDashboardSessions', () => {
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-scope-')));
  });

  afterEach(async () => {
    host?.kill('SIGKILL');
    host = undefined;
    if (home.length > 0) {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns only active sessions in active scope', async () => {
    await seedSession({
      sessionId: 'running-1',
      status: 'running',
      hostPid: startHost('running-1'),
      createdAt: '2026-06-02T12:00:02.000Z',
    });
    await seedSession({
      sessionId: 'exited-1',
      status: 'exited',
      createdAt: '2026-06-02T12:00:01.000Z',
    });

    const sessions = await listDashboardSessions(home, 'active');

    expect(sessions.map((session) => session.sessionId)).toEqual(['running-1']);
  });

  it('includes terminal sessions but excludes destroyed in all scope, newest-first', async () => {
    await seedSession({
      sessionId: 'running-1',
      status: 'running',
      hostPid: startHost('running-1'),
      createdAt: '2026-06-02T12:00:02.000Z',
    });
    await seedSession({
      sessionId: 'exited-1',
      status: 'exited',
      createdAt: '2026-06-02T12:00:01.000Z',
    });
    await seedSession({
      sessionId: 'destroyed-1',
      status: 'destroyed',
      createdAt: '2026-06-02T12:00:03.000Z',
    });

    const sessions = await listDashboardSessions(home, 'all');

    expect(sessions.map((session) => session.sessionId)).toEqual([
      'running-1',
      'exited-1',
    ]);
  });

  it('enriches each session with its replay dimensions and event-log path', async () => {
    await seedSession({
      sessionId: 'running-1',
      status: 'running',
      hostPid: startHost('running-1'),
      cols: 80,
      rows: 24,
      creationCols: 120,
      creationRows: 40,
    });

    const [session] = await listDashboardSessions(home, 'active');

    expect(session?.initialCols).toBe(120);
    expect(session?.initialRows).toBe(40);
    expect(session?.eventLog).toBe(eventLogPath(sessionDir(home, 'running-1')));
  });
});
