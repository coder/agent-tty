import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { createSession } from '../helpers.js';
import { invariant } from '../../src/util/assert.js';

const CLEANUP = resolve('.agents/skills/verify-agent-tty/scripts/cleanup.sh');
const CLI = resolve('src/cli/main.ts');
const TSX_LOADER = import.meta.resolve('tsx');
const CLEANUP_TIMEOUT_MS = 60_000;

interface Run {
  root: string;
  home: string;
  state: string;
  evidence: string;
  envFile: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeRun(): Run {
  // oxfmt-ignore
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-verify-cleanup-')));
  const run = {
    root,
    home: join(root, 'home'),
    state: join(root, 'state'),
    evidence: join(root, 'evidence'),
    envFile: join(root, 'env.sh'),
  };
  for (const folder of [run.home, run.state, run.evidence]) {
    mkdirSync(folder);
  }
  writeFileSync(
    run.envFile,
    [
      `export VERIFY_RUN=${quote(run.root)}`,
      `export AGENT_TTY_HOME=${quote(run.home)}`,
      `export XDG_STATE_HOME=${quote(run.state)}`,
      `export EVIDENCE=${quote(run.evidence)}`,
      'export NODE_OPTIONS="--disable-warning=DEP0205"',
      `att() { node --import ${quote(TSX_LOADER)} ${quote(CLI)} "$@"; }`,
      '',
    ].join('\n'),
  );
  return run;
}

function runCleanup(
  run: Run,
  cwd: string,
  prefix: string[] = [],
): { status: number | null; stderr: string } {
  const command = [...prefix, 'bash', CLEANUP, run.envFile];
  const [file, ...args] = command;
  invariant(file !== undefined, 'cleanup command must not be empty');
  const result = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    timeout: CLEANUP_TIMEOUT_MS,
  });
  return { status: result.status, stderr: result.stderr };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canRunAsPidOne(): boolean {
  const probe = spawnSync(
    'sudo',
    [
      '-n',
      'unshare',
      '--pid',
      '--fork',
      '--mount-proc',
      'setpriv',
      `--reuid=${String(process.getuid?.())}`,
      `--regid=${String(process.getgid?.())}`,
      '--init-groups',
      'sh',
      '-c',
      'echo $$',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  return probe.status === 0 && probe.stdout.trim() === '1';
}

describe.skipIf(process.platform !== 'linux')(
  'verify-agent-tty cleanup.sh',
  { timeout: 120_000 },
  () => {
    let run: Run | undefined;
    let holder: ChildProcess | undefined;

    afterEach(() => {
      holder?.kill('SIGKILL');
      holder = undefined;
      if (run !== undefined) {
        rmSync(run.root, { recursive: true, force: true });
        run = undefined;
      }
    });

    it('destroys a live session, keeps its files in evidence/ and removes home/ and state/', () => {
      run = makeRun();
      const sessionId = createSession(run.home, ['/bin/sh', '-c', 'exec cat'], {
        env: { XDG_STATE_HOME: run.state },
      });
      const manifestPath = join(
        run.home,
        'sessions',
        sessionId,
        'session.json',
      );
      const { hostPid } = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        hostPid: number;
      };

      const result = runCleanup(run, run.root);

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(run.home)).toBe(false);
      expect(existsSync(run.state)).toBe(false);
      expect(
        existsSync(join(run.evidence, 'sessions', sessionId, 'session.json')),
      ).toBe(true);
      expect(isAlive(hostPid)).toBe(false);
    });

    it('keeps home/ and names a process that holds a path in it, then removes home/ once it ends', () => {
      run = makeRun();
      holder = spawn('sleep', ['60'], {
        cwd: run.home,
        detached: true,
        stdio: 'ignore',
      });
      const pid = holder.pid;
      invariant(pid !== undefined, 'holder must have a pid');

      const blocked = runCleanup(run, run.root);

      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain(`${String(pid)} sleep 60`);
      expect(blocked.stderr).toContain('(uses a path in the run)');
      expect(existsSync(run.home)).toBe(true);
      expect(isAlive(pid)).toBe(true);

      holder.kill('SIGKILL');
      holder = undefined;
      const result = runCleanup(run, run.root);

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(run.home)).toBe(false);
    });

    it('removes home/ when cleanup.sh starts inside it', () => {
      run = makeRun();

      const result = runCleanup(run, run.home);

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(run.home)).toBe(false);
    });

    it.skipIf(!canRunAsPidOne())(
      'removes home/ when cleanup.sh runs as pid 1 inside it',
      () => {
        run = makeRun();

        const result = runCleanup(run, run.home, [
          'sudo',
          '-n',
          'env',
          `PATH=${process.env.PATH ?? ''}`,
          `HOME=${process.env.HOME ?? ''}`,
          'unshare',
          '--pid',
          '--fork',
          '--mount-proc',
          'setpriv',
          `--reuid=${String(process.getuid?.())}`,
          `--regid=${String(process.getgid?.())}`,
          '--init-groups',
        ]);

        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(run.home)).toBe(false);
      },
    );
  },
);
