import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  inspectSession,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

let testHome = '';
let subreaper: ChildProcess | undefined;
let pgid = 0;

function groupStates(group: number): string[] {
  const ps = spawnSync('ps', ['-eo', 'pgid=,s='], { encoding: 'utf8' });
  expect(ps.status).toBe(0);
  return ps.stdout.split('\n').flatMap((line) => {
    const [id, state] = line.trim().split(/\s+/);
    return Number(id) === group && state !== undefined ? [state] : [];
  });
}

// PR_SET_CHILD_SUBREAPER, which the helper uses, exists only on Linux.
describe.runIf(process.platform === 'linux')(
  'a session created under an init that never reaps',
  { timeout: 30000 },
  () => {
    beforeEach(async () => {
      // oxfmt-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
    });

    afterEach(async () => {
      // The subreaper's zombies go to init, which reaps them.
      subreaper?.kill('SIGKILL');
      subreaper = undefined;
      if (pgid > 1) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // the group is already gone
        }
      }
      pgid = 0;
      await cleanupHome(testHome);
    });

    // The subreaper adopts the host once `create` exits, and the program's
    // orphans once the program dies. `script` touches "$0" once its traps
    // are set.
    async function createUnderSubreaper(script: string): Promise<string> {
      const ready = join(testHome, 'program-ready');
      const child = spawn(
        'python3',
        [
          resolve('test/fixtures/non-reaping-subreaper.py'),
          process.execPath,
          '--import',
          'tsx',
          './src/cli/main.ts',
          'create',
          '--json',
          '--',
          '/bin/sh',
          '-c',
          script,
          ready,
        ],
        {
          env: { ...process.env, AGENT_TTY_HOME: testHome },
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      );
      subreaper = child;
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      await once(child.stdout, 'end');
      const envelope = JSON.parse(stdout) as SuccessEnvelope<{
        sessionId: string;
      }>;
      expect(envelope.ok).toBe(true);
      const { sessionId } = envelope.result;

      const childPid = inspectSession(testHome, sessionId).childPid;
      expect(childPid).toBeTypeOf('number');
      pgid = childPid as number;
      const deadline = Date.now() + 10_000;
      while (
        !(await stat(ready).then(
          () => true,
          () => false,
        ))
      ) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(50);
      }
      return sessionId;
    }

    it('destroy ends a program whose killed background process stays a zombie', async () => {
      const sessionId = await createUnderSubreaper(
        'trap "" HUP; sleep 300 & touch "$0"; wait',
      );

      const destroy = runCli(['destroy', sessionId, '--json'], {
        AGENT_TTY_HOME: testHome,
      });
      expect(JSON.parse(destroy.stdout)).toMatchObject({
        ok: true,
        result: { sessionId, destroyed: true },
      });
      expect(destroy.status).toBe(0);
      expect(inspectSession(testHome, sessionId).status).toBe('destroyed');
      expect(groupStates(pgid)).toEqual(['Z']);

      const startedAt = Date.now();
      const list = runCli(['list', '--json'], { AGENT_TTY_HOME: testHome });
      expect(list.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
  },
);
