import { mkdtemp, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionDir, socketPath } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createSession,
  destroySession,
  inspectSession,
  runCli,
  type SuccessEnvelope,
} from '../helpers.js';

let testHome = '';

// Unix mode bits are not meaningful on Windows (tier-2), where the socket is a
// named pipe and chmod is a no-op; skip the whole suite there.
describe.skipIf(process.platform === 'win32')(
  'socket and state file permissions',
  { timeout: 30000 },
  () => {
    beforeEach(async () => {
      testHome = await realpath(
        await mkdtemp(join(tmpdir(), 'agent-tty-home-')),
      );
    });

    afterEach(async () => {
      await cleanupHome(testHome);
    });

    it('restricts the socket directory, socket file, and manifest to the owner', async () => {
      const sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);

      const sPath = socketPath(sessionDir(testHome, sessionId));
      const socketDirectory = dirname(sPath);

      // Socket directory is owner-only (0o700), regardless of umask.
      const directoryStat = await stat(socketDirectory);
      expect(directoryStat.mode & 0o777).toBe(0o700);

      // Socket file is owner-only (0o600), created during listen().
      const socketStat = await stat(sPath);
      expect(socketStat.mode & 0o777).toBe(0o600);

      // Session manifest is owner-only (0o600).
      const manifestStat = await stat(
        join(testHome, 'sessions', sessionId, 'session.json'),
      );
      expect(manifestStat.mode & 0o777).toBe(0o600);

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
    });
  },
);
