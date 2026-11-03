import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readManifest, writeManifest } from '../../src/storage/manifests.js';
import {
  legacySocketPath,
  manifestPath,
  sessionDir,
  socketPath,
} from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  crashSession,
  createSession,
  inspectSession,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

let testHome = '';

function socketDirectoryOf(sessionId: string): string {
  return dirname(socketPath(sessionDir(testHome, sessionId)));
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    expect(Date.now()).toBeLessThan(deadline);
    await sleep(50);
  }
}

// A host of an older version listens at the old path. A rename of the
// socket file keeps the host listening on it.
function moveSocketToOldPath(sessionId: string): string {
  const socketFile = socketPath(sessionDir(testHome, sessionId));
  const oldSocketFile = legacySocketPath(socketFile);
  expect(oldSocketFile).not.toBeNull();
  if (oldSocketFile === null) {
    throw new Error('the platform has no old socket path');
  }
  mkdirSync(dirname(oldSocketFile), { recursive: true, mode: 0o700 });
  chmodSync(dirname(oldSocketFile), 0o700);
  renameSync(socketFile, oldSocketFile);
  return oldSocketFile;
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

    it('lies in a root of the uid that only the owner can use', () => {
      const sessionId = createSession(testHome);
      const root = dirname(socketDirectoryOf(sessionId));

      expect(root).toBe(`/tmp/agent-tty-${String(process.getuid?.())}`);
      const stats = lstatSync(root);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.uid).toBe(process.getuid?.());
      expect(stats.mode & 0o077).toBe(0);
    });

    it('a CLI reaches a host that listens at the old path, and destroy removes that path', () => {
      const sessionId = createSession(testHome);
      const oldSocketFile = moveSocketToOldPath(sessionId);
      const env = { AGENT_TTY_HOME: testHome };

      expect(
        runCli(['type', sessionId, 'old-path', '--json'], env).status,
      ).toBe(0);
      expect(runCli(['destroy', sessionId, '--json'], env).status).toBe(0);
      expect(existsSync(oldSocketFile)).toBe(false);
      expect(existsSync(dirname(oldSocketFile))).toBe(false);
    });

    it('a CLI does not follow a symlink at the old path', () => {
      const sessionId = createSession(testHome);
      const oldSocketFile = moveSocketToOldPath(sessionId);
      const moved = join(testHome, 'moved.sock');
      renameSync(oldSocketFile, moved);
      symlinkSync(moved, oldSocketFile);
      const env = { AGENT_TTY_HOME: testHome };

      try {
        const result = runCli(['type', sessionId, 'old-path', '--json'], env);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: 'HOST_UNREACHABLE' },
        });
      } finally {
        rmSync(oldSocketFile, { force: true });
        rmSync(dirname(oldSocketFile), { recursive: true, force: true });
        renameSync(moved, socketPath(sessionDir(testHome, sessionId)));
      }
    });

    it.each([
      ['gc', 'exited'],
      ['destroy', 'destroyed'],
    ] as const)(
      '%s removes it when the host died after it wrote %s',
      async (command, status) => {
        const sessionId = createSession(testHome);
        const { hostPid } = inspectSession(testHome, sessionId);
        expect(hostPid).toBeTypeOf('number');
        crashSession(testHome, sessionId);
        await waitForExit(hostPid ?? 0);
        const manifestFile = manifestPath(sessionDir(testHome, sessionId));
        await writeManifest(manifestFile, {
          ...(await readManifest(manifestFile)),
          status,
          childPid: null,
          exitCode: 0,
        });
        const directory = socketDirectoryOf(sessionId);
        expect(existsSync(directory)).toBe(true);

        const result = runCli(
          command === 'gc'
            ? ['gc', '--json']
            : ['destroy', sessionId, '--json'],
          { AGENT_TTY_HOME: testHome },
        );
        expect(JSON.parse(result.stdout)).toMatchObject(
          command === 'gc'
            ? {
                ok: true,
                result: { homes: [{ removedSessions: [sessionId] }] },
              }
            : { ok: false, error: { code: 'SESSION_ALREADY_DESTROYED' } },
        );
        expect(existsSync(directory)).toBe(false);
      },
    );

    it('destroy --force removes it after it kills the host', () => {
      const sessionId = createSession(testHome);
      const directory = socketDirectoryOf(sessionId);

      expect(
        runCli(['destroy', sessionId, '--force', '--json'], {
          AGENT_TTY_HOME: testHome,
        }).status,
      ).toBe(0);
      expect(existsSync(directory)).toBe(false);
    });

    it('a host whose rmdir fails with EBUSY still exits cleanly', async () => {
      const exitFile = join(testHome, 'host-exit');
      const sessionId = createSession(testHome, undefined, {
        env: {
          HOST_EXIT_FILE: exitFile,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS ?? '',
            `--import=${pathToFileURL(resolve('test/fixtures/host-rmdir-ebusy.ts')).href}`,
          ].join(' '),
        },
      });

      expect(
        runCli(['destroy', sessionId, '--json'], { AGENT_TTY_HOME: testHome })
          .status,
      ).toBe(0);
      const deadline = Date.now() + 10_000;
      while (!existsSync(exitFile)) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(50);
      }
      expect(readFileSync(exitFile, 'utf8')).toBe('0\n');
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

    it.each(['', 'bind'])(
      'doctor passes its socket check and leaves no directory (removed before: %s)',
      (step) => {
        const result = runCli(['doctor', '--json'], {
          AGENT_TTY_HOME: testHome,
          ...(step === ''
            ? {}
            : {
                REMOVE_SOCKET_DIRECTORY_BEFORE: step,
                NODE_OPTIONS: [
                  process.env.NODE_OPTIONS ?? '',
                  `--import=${pathToFileURL(resolve('test/fixtures/remove-socket-directory-once.ts')).href}`,
                ].join(' '),
              }),
        });
        const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
          checks: { environment: Array<{ name: string; status: string }> };
        }>;
        expect(envelope.result.checks.environment).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'socket-viable', status: 'pass' }),
          ]),
        );
        expect(existsSync(dirname(socketPath(sessionDir(testHome, 'x'))))).toBe(
          false,
        );
      },
      60_000,
    );

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
