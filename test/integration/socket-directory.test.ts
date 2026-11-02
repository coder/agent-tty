import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionDir, socketPath } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  crashSession,
  createSession,
  inspectSession,
  runCli,
  sleep,
} from '../helpers.js';

let testHome = '';

function socketDirectoryOf(sessionId: string): string {
  return dirname(socketPath(sessionDir(testHome, sessionId)));
}

async function waitForRemoval(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (existsSync(path)) {
    expect(Date.now()).toBeLessThan(deadline);
    await sleep(50);
  }
}

describe.skipIf(process.platform === 'win32')(
  'socket directory',
  { timeout: 30_000 },
  () => {
    beforeEach(async () => {
      testHome = await realpath(
        await mkdtemp(join(tmpdir(), 'agent-tty-socket-dir-')),
      );
    });

    afterEach(async () => {
      await cleanupHome(testHome);
    });

    it('destroy removes it with the last socket of the Home', () => {
      const first = createSession(testHome);
      const second = createSession(testHome);
      const directory = socketDirectoryOf(first);
      const env = { AGENT_TTY_HOME: testHome };

      expect(runCli(['destroy', first, '--json'], env).status).toBe(0);
      expect(readdirSync(directory)).toEqual([
        socketPath(sessionDir(testHome, second)).slice(directory.length + 1),
      ]);
      expect(inspectSession(testHome, second).status).toBe('running');
      expect(
        runCli(['type', second, 'still-reachable', '--json'], env).status,
      ).toBe(0);

      expect(runCli(['destroy', second, '--json'], env).status).toBe(0);
      expect(existsSync(directory)).toBe(false);
    });

    it('a host whose program exits removes it', async () => {
      const sessionId = createSession(testHome, ['/bin/sh', '-c', 'sleep 1']);
      await waitForRemoval(socketDirectoryOf(sessionId));
      expect(inspectSession(testHome, sessionId).status).toBe('exited');
    });

    it('a reconcile after a host crash removes it', async () => {
      const sessionId = createSession(testHome);
      crashSession(testHome, sessionId);
      await sleep(500);
      expect(inspectSession(testHome, sessionId).status).toBe('failed');
      expect(existsSync(socketDirectoryOf(sessionId))).toBe(false);
    });

    it.each(['chmod', 'bind'])(
      'a host listens when the directory vanishes before its %s',
      (step) => {
        const sessionId = createSession(testHome, undefined, {
          env: {
            REMOVE_SOCKET_DIRECTORY_BEFORE: step,
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS ?? '',
              `--import=${pathToFileURL(resolve('test/fixtures/remove-socket-directory-once.ts')).href}`,
            ].join(' '),
          },
        });
        expect(inspectSession(testHome, sessionId).status).toBe('running');
        expect(
          runCli(['type', sessionId, 'reachable', '--json'], {
            AGENT_TTY_HOME: testHome,
          }).status,
        ).toBe(0);
      },
    );
  },
);
