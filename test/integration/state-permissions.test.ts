import { mkdtemp, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  inspectSession,
  runCli,
  type SuccessEnvelope,
} from '../helpers.js';

let testBase = '';
let testHome = '';
let sessionId = '';

// Unix mode bits are not meaningful on Windows (tier-2), where chmod is a
// no-op; skip the whole suite there.
describe.skipIf(process.platform === 'win32')(
  'Home directory, session directory, and event log permissions',
  { timeout: 30000 },
  () => {
    beforeEach(async () => {
      // Use a *nested* path so ensureHome is responsible for creating testHome
      // (not mkdtemp, which already returns 0o700 and would pass without the
      // new chmod). mkdtemp gives us a clean base; we point AGENT_TTY_HOME at
      // base/home which does not yet exist.
      testBase = await realpath(
        await mkdtemp(join(tmpdir(), 'agent-tty-perms-')),
      );
      testHome = join(testBase, 'home');
      sessionId = '';
    });

    afterEach(async () => {
      if (sessionId.length > 0) {
        destroySession(testHome, sessionId);
      }
      await cleanupHome(testHome);
    });

    it('restricts the Home directory, session directory, and event log to the owner', async () => {
      sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);

      // Home directory is owner-only (0o700) — ensureHome created it.
      const homeStat = await stat(testHome);
      expect(homeStat.mode & 0o777).toBe(0o700);

      // Session directory is owner-only (0o700), regardless of umask.
      const sessionDirStat = await stat(join(testHome, 'sessions', sessionId));
      expect(sessionDirStat.mode & 0o777).toBe(0o700);

      // Event log is owner-only (0o600) — belt-and-suspenders inside the
      // session directory.
      const eventLogStat = await stat(
        join(testHome, 'sessions', sessionId, 'events.jsonl'),
      );
      expect(eventLogStat.mode & 0o777).toBe(0o600);

      // The owner can still drive the session despite the tightened perms.
      const inspected = inspectSession(testHome, sessionId);
      expect(inspected.status).toBe('running');

      const typeResult = runCli(
        ['type', sessionId, 'echo owner-ok\n', '--json'],
        {
          AGENT_TTY_HOME: testHome,
        },
      );
      expect(typeResult.status).toBe(0);
      expect(typeResult.stderr).toBe('');
      const typeEnvelope = JSON.parse(typeResult.stdout) as SuccessEnvelope<
        Record<string, unknown>
      >;
      expect(typeEnvelope.ok).toBe(true);

      destroySession(testHome, sessionId);
      sessionId = '';
    });
  },
);
