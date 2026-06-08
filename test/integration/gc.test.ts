import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  crashSession,
  createSession,
  destroySession,
  inspectSession,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let testHome = '';

describe('gc integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-gc-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('removes an exited session directory after destroy', async () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'echo ready; sleep 30',
    ]);
    const sessionDirectory = join(testHome, 'sessions', sessionId);

    const destroyResult = runCli(['destroy', sessionId, '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
    expect(destroyResult.stderr).toBe('');
    expect(await pathExists(sessionDirectory)).toBe(true);

    const gcResult = runCli(['gc', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(gcResult.status).toBe(0);
    expect(gcResult.stderr).toBe('');

    const gcEnvelope = JSON.parse(gcResult.stdout) as SuccessEnvelope<GcResult>;
    expect(gcEnvelope.ok).toBe(true);
    expect(gcEnvelope.command).toBe('gc');
    // AGENT_TTY_HOME is set → gc is scoped to this one Home (no registry sweep).
    expect(gcEnvelope.result.homes).toHaveLength(1);
    const outcome = gcEnvelope.result.homes[0];
    expect(outcome?.home).toBe(testHome);
    expect(outcome?.removedSessions).toEqual([sessionId]);
    expect(outcome?.skippedSessions).toEqual([]);
    expect(gcEnvelope.result.dryRun).toBe(false);
    expect(gcEnvelope.result.removedSessionCount).toBe(1);
    expect(gcEnvelope.result.totalBytesFreed).toBeGreaterThan(0);
    expect(gcEnvelope.result.deregisteredHomes).toEqual([]);
    expect(await pathExists(sessionDirectory)).toBe(false);
    // gc never deletes the Home directory itself.
    expect(await pathExists(testHome)).toBe(true);
  });

  it('gc collects exited, failed, and destroyed sessions', async () => {
    const exitedId = createSession(testHome, ['/bin/sh', '-c', 'exit 0']);
    await sleep(2000);

    const failedId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
    crashSession(testHome, failedId);
    await sleep(500);

    const destroyedId = createSession(testHome, ['/bin/sh', '-c', 'exec cat']);
    destroySession(testHome, destroyedId);

    const exitedSession = inspectSession(testHome, exitedId);
    expect(exitedSession.status).toBe('exited');

    const failedSession = inspectSession(testHome, failedId);
    expect(failedSession.status).toBe('failed');

    const destroyedSession = inspectSession(testHome, destroyedId);
    expect(destroyedSession.status).toBe('destroyed');

    const gcResult = runCli(['gc', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(gcResult.status).toBe(0);
    expect(gcResult.stderr).toBe('');

    const gcEnvelope = JSON.parse(gcResult.stdout) as SuccessEnvelope<GcResult>;
    expect(gcEnvelope.ok).toBe(true);
    expect(gcEnvelope.result.homes).toHaveLength(1);
    const outcome = gcEnvelope.result.homes[0];
    expect(outcome?.removedSessions).toHaveLength(3);
    expect(outcome?.removedSessions).toContain(exitedId);
    expect(outcome?.removedSessions).toContain(failedId);
    expect(outcome?.removedSessions).toContain(destroyedId);
    expect(outcome?.skippedSessions).toEqual([]);
    expect(gcEnvelope.result.removedSessionCount).toBe(3);
  });
});

describe('gc cross-Home integration', { timeout: 30000 }, () => {
  // Seed a terminal (exited) Session directly so the cross-Home sweep needs no
  // live host — gc reconciles a terminal Session to a no-op and collects it.
  async function seedExitedSession(
    home: string,
    sessionId: string,
  ): Promise<void> {
    const dir = join(home, 'sessions', sessionId);
    await mkdir(dir, { recursive: true });
    const manifest = {
      version: 1,
      sessionId,
      createdAt: '2026-06-08T10:00:00.000Z',
      updatedAt: '2026-06-08T10:00:00.000Z',
      status: 'exited',
      command: ['/bin/sh', '-c', 'exit 0'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      hostPid: null,
      childPid: null,
      exitCode: 0,
      exitSignal: null,
    };
    await writeFile(
      join(dir, 'session.json'),
      JSON.stringify(manifest),
      'utf8',
    );
    await writeFile(join(dir, 'events.jsonl'), '', 'utf8');
  }

  // Run the real CLI with a sanitized env: no AGENT_TTY_HOME (so gc is NOT
  // scoped and performs the cross-Home registry sweep), a fake HOME (so the
  // resolved default Home is hermetic and absent), and a temp XDG_STATE_HOME
  // (so the Home Registry is hermetic).
  function runGcCrossHome(fakeHome: string, stateHome: string) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.AGENT_TTY_HOME;
    env.HOME = fakeHome;
    env.XDG_STATE_HOME = stateHome;
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', './src/cli/main.ts', 'gc', '--json'],
      { cwd: process.cwd(), encoding: 'utf8', env, timeout: 30000 },
    );
  }

  it('sweeps every registered Home by default and deregisters emptied or gone ones', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-gc-xhome-')),
    );
    try {
      const fakeHome = join(root, 'fake-home'); // default Home → fakeHome/.agent-tty (absent)
      const stateHome = join(root, 'state');
      const homeA = join(root, 'home-a');
      const homeB = join(root, 'home-b');
      const homeGone = join(root, 'home-gone'); // registered but never created on disk
      await mkdir(fakeHome, { recursive: true });
      await seedExitedSession(homeA, 'a-exit');
      await seedExitedSession(homeB, 'b-exit');
      await mkdir(join(stateHome, 'agent-tty'), { recursive: true });
      await writeFile(
        join(stateHome, 'agent-tty', 'homes.json'),
        JSON.stringify({
          version: 1,
          homes: [
            { path: homeA, lastSeenAt: '2026-06-08T12:00:00.000Z' },
            { path: homeB, lastSeenAt: '2026-06-07T12:00:00.000Z' },
            { path: homeGone, lastSeenAt: '2026-06-06T12:00:00.000Z' },
          ],
        }),
        'utf8',
      );

      const result = runGcCrossHome(fakeHome, stateHome);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const envelope = JSON.parse(result.stdout) as SuccessEnvelope<GcResult>;
      expect(envelope.ok).toBe(true);

      // Both registered Homes' Sessions are collected in one sweep.
      expect(envelope.result.removedSessionCount).toBe(2);
      const sweptHomes = envelope.result.homes.map((home) => home.home);
      expect(sweptHomes).toContain(homeA);
      expect(sweptHomes).toContain(homeB);

      // Emptied + gone Homes are deregistered; the unregistered default Home is not.
      const deregistered = envelope.result.deregisteredHomes;
      expect(deregistered).toContain(homeA);
      expect(deregistered).toContain(homeB);
      expect(deregistered).toContain(homeGone);
      expect(deregistered.some((home) => home.includes('fake-home'))).toBe(
        false,
      );

      // The registry is compacted to empty after deregistration.
      const registryRaw = await readFile(
        join(stateHome, 'agent-tty', 'homes.json'),
        'utf8',
      );
      expect((JSON.parse(registryRaw) as { homes: unknown[] }).homes).toEqual(
        [],
      );

      // Session directories are collected, but Home directories are never deleted.
      expect(await pathExists(homeA)).toBe(true);
      expect(await pathExists(homeB)).toBe(true);
      expect(await pathExists(join(homeA, 'sessions', 'a-exit'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
