import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupHome, createSession } from '../helpers.js';
import { invariant } from '../../src/util/assert.js';

const CLEANUP = resolve('.agents/skills/verify-agent-tty/scripts/cleanup.sh');
const CLI = resolve('src/cli/main.ts');
const TSX_LOADER = import.meta.resolve('tsx');
const CLEANUP_TIMEOUT_MS = 60_000;
const ADOPTED_HOLDER_IN_HOME =
  '[ "$$" != 1 ] || (cd "$AGENT_TTY_HOME" && exec sleep 60 &)';

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

function makeRun(
  options: { envExtra?: string[]; relativeTo?: 'parent' } = {},
): Run {
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
  const written = options.relativeTo === 'parent' ? basename(root) : root;
  writeFileSync(
    run.envFile,
    [
      `export VERIFY_RUN=${quote(written)}`,
      `export AGENT_TTY_HOME=${quote(join(written, 'home'))}`,
      `export XDG_STATE_HOME=${quote(join(written, 'state'))}`,
      `export EVIDENCE=${quote(join(written, 'evidence'))}`,
      'export NODE_OPTIONS="--disable-warning=DEP0205"',
      `att() { node --import ${quote(TSX_LOADER)} ${quote(CLI)} "$@"; }`,
      ...(options.envExtra ?? []),
      '',
    ].join('\n'),
  );
  return run;
}

function runCleanup(
  run: Run,
  cwd: string,
  options: { prefix?: string[]; stderrPath?: string } = {},
): { status: number | null; stderr: string } {
  const command = [...(options.prefix ?? []), 'bash', CLEANUP, run.envFile];
  const [file, ...args] = command;
  invariant(file !== undefined, 'cleanup command must not be empty');
  const stderrFd =
    options.stderrPath === undefined
      ? undefined
      : openSync(options.stderrPath, 'w');
  try {
    const result = spawnSync(file, args, {
      cwd,
      encoding: 'utf8',
      timeout: CLEANUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', stderrFd ?? 'pipe'],
    });
    return {
      status: result.status,
      stderr: stderrFd === undefined ? result.stderr : '',
    };
  } finally {
    if (stderrFd !== undefined) {
      closeSync(stderrFd);
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidOnePrefix(): string[] {
  return [
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
  ];
}

function canRunAsPidOne(): boolean {
  const [file, ...args] = pidOnePrefix();
  invariant(file !== undefined, 'pid 1 prefix must not be empty');
  const probe = spawnSync(file, [...args, 'sh', '-c', 'echo $$'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return probe.status === 0 && probe.stdout.trim() === '1';
}

const PID_ONE_AVAILABLE = process.platform === 'linux' && canRunAsPidOne();
// CI sets AGENT_TTY_REQUIRE_PID1_UNSHARE=1, so a runner without passwordless
// sudo, unshare or setpriv fails the pid 1 tests there instead of skipping them.
const REQUIRE_PID_ONE = process.env.AGENT_TTY_REQUIRE_PID1_UNSHARE === '1';

describe.skipIf(process.platform !== 'linux')(
  'verify-agent-tty cleanup.sh',
  { timeout: 120_000 },
  () => {
    let run: Run | undefined;
    let holder: ChildProcess | undefined;

    afterEach(async () => {
      holder?.kill('SIGKILL');
      holder = undefined;
      if (run !== undefined) {
        await cleanupHome(run.home);
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

    it('removes home/ and state/ of a run whose env.sh uses paths relative to the caller', () => {
      run = makeRun({ relativeTo: 'parent' });

      const result = runCleanup(run, dirname(run.root));

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(run.home)).toBe(false);
      expect(existsSync(run.state)).toBe(false);
      expect(existsSync(run.evidence)).toBe(true);
    });

    describe.runIf(PID_ONE_AVAILABLE || REQUIRE_PID_ONE)('as pid 1', () => {
      beforeEach(() => {
        expect(
          PID_ONE_AVAILABLE,
          'AGENT_TTY_REQUIRE_PID1_UNSHARE=1 needs passwordless sudo, unshare and setpriv',
        ).toBe(true);
      });

      it('removes home/ when cleanup.sh starts inside it', () => {
        run = makeRun();

        const result = runCleanup(run, run.home, { prefix: pidOnePrefix() });

        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(run.home)).toBe(false);
      });

      it('removes home/ when its own stderr goes to a file in home/', () => {
        run = makeRun();

        const result = runCleanup(run, run.root, {
          prefix: pidOnePrefix(),
          stderrPath: join(run.home, 'cleanup.log'),
        });

        expect(result.status).toBe(0);
        expect(existsSync(run.home)).toBe(false);
      });

      it('keeps home/ when a process that pid 1 adopted holds a path in it', () => {
        run = makeRun({ envExtra: [ADOPTED_HOLDER_IN_HOME] });

        const result = runCleanup(run, run.root, { prefix: pidOnePrefix() });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(
          / sleep 60 {2}\(uses a path in the run\)/u,
        );
        expect(existsSync(run.home)).toBe(true);
      });
    });
  },
);
