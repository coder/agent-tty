import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionRecordSchema } from '../../src/protocol/schemas.js';
import { hasErrorCode } from '../../src/util/hasErrorCode.js';
import {
  cleanupHome,
  crashSession,
  createSession,
  inspectSession,
  killGroupIfAlive,
  runCli,
  sleep,
} from '../helpers.js';

// Path to a setpriv copy with the cap_setuid and cap_setgid file
// capabilities. A plain setpriv cannot change the user.
const setpriv = process.env.AGENT_TTY_TEST_SETPRIV;
// CI sets AGENT_TTY_REQUIRE_SETPRIV=1, so a missing helper fails these tests
// there instead of skipping them.
const requireSetpriv = process.env.AGENT_TTY_REQUIRE_SETPRIV === '1';
const nobody = '65534';

function asNobody(args: string[]): { status: number | null; stdout: string } {
  if (setpriv === undefined) {
    throw new Error('AGENT_TTY_TEST_SETPRIV must be set');
  }
  return spawnSync(
    setpriv,
    [`--reuid=${nobody}`, `--regid=${nobody}`, '--clear-groups', ...args],
    { encoding: 'utf8' },
  );
}

// pgrep runs as nobody, because hidepid=2 hides the processes of nobody from
// the test's user.
function nobodySleepIn(group: number): boolean {
  return (
    asNobody(['pgrep', '-U', nobody, '-g', String(group), '-x', 'sleep'])
      .status === 0
  );
}

const shellWaitingOnHangupProofNobodySleep = `"$0" --reuid=${nobody} --regid=${nobody} --clear-groups /bin/sh -c 'trap "" HUP; exec sleep 300' & wait`;

describe.runIf(
  process.platform === 'linux' && (setpriv !== undefined || requireSetpriv),
)(
  "a program group that holds another user's process",
  { timeout: 60_000 },
  () => {
    let testHome = '';
    let pgid = 0;

    beforeEach(async () => {
      expect(
        setpriv,
        'AGENT_TTY_REQUIRE_SETPRIV=1 needs AGENT_TTY_TEST_SETPRIV',
      ).toBeDefined();
      // oxfmt-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
    });

    afterEach(async () => {
      try {
        if (pgid > 1) {
          asNobody(['pkill', '-KILL', '-U', nobody, '-g', String(pgid)]);
          try {
            killGroupIfAlive(pgid);
          } catch (error) {
            // The killed nobody process stays in the group as a zombie until
            // it is reaped, and kill(-pgid) refuses a group that holds only
            // processes of another user.
            if (!hasErrorCode(error, 'EPERM')) {
              throw error;
            }
          }
        }
      } finally {
        pgid = 0;
        await cleanupHome(testHome);
        testHome = '';
      }
    });

    async function createGroupWithNobodyProcess(): Promise<string> {
      const sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        shellWaitingOnHangupProofNobodySleep,
        setpriv as string,
      ]);
      const childPid = inspectSession(testHome, sessionId).childPid;
      expect(childPid).toBeTypeOf('number');
      pgid = childPid as number;
      const deadline = Date.now() + 10_000;
      while (!nobodySleepIn(pgid)) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(50);
      }
      return sessionId;
    }

    function endNobodyProcess(): void {
      expect(
        asNobody(['pkill', '-KILL', '-U', nobody, '-g', String(pgid)]).status,
      ).toBe(0);
    }

    async function readStatus(sessionId: string): Promise<string> {
      return SessionRecordSchema.parse(
        JSON.parse(
          await readFile(
            join(testHome, 'sessions', sessionId, 'session.json'),
            'utf8',
          ),
        ) as unknown,
      ).status;
    }

    async function statusBecomes(
      sessionId: string,
      status: string,
    ): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (inspectSession(testHome, sessionId).status !== status) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(200);
      }
    }

    function destroy(sessionId: string, ...flags: string[]) {
      const result = runCli(['destroy', sessionId, ...flags, '--json'], {
        AGENT_TTY_HOME: testHome,
      });
      return {
        status: result.status,
        envelope: JSON.parse(result.stdout) as {
          ok: boolean;
          error?: { code: string };
        },
      };
    }

    it('destroy times out until the process ends, then the session is destroyed', async () => {
      const sessionId = await createGroupWithNobodyProcess();

      const result = destroy(sessionId);
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: 'HOST_TIMEOUT' },
      });
      expect(result.status).toBe(5);
      expect(await readStatus(sessionId)).toBe('destroying');
      expect(nobodySleepIn(pgid)).toBe(true);

      endNobodyProcess();
      await statusBecomes(sessionId, 'destroyed');
    });

    it('destroy --force times out without recording destroyed', async () => {
      const sessionId = await createGroupWithNobodyProcess();

      const result = destroy(sessionId, '--force');
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: 'HOST_TIMEOUT' },
      });
      expect(result.status).toBe(5);
      expect(await readStatus(sessionId)).not.toBe('destroyed');
      expect(nobodySleepIn(pgid)).toBe(true);

      endNobodyProcess();
      expect(destroy(sessionId, '--force').status).toBe(0);
      expect(await readStatus(sessionId)).toBe('destroyed');
    });

    it('a reconcile after a host crash keeps the session until the process ends', async () => {
      const sessionId = await createGroupWithNobodyProcess();
      crashSession(testHome, sessionId);
      await sleep(500);

      expect(inspectSession(testHome, sessionId).status).toBe('running');
      expect(nobodySleepIn(pgid)).toBe(true);

      endNobodyProcess();
      await statusBecomes(sessionId, 'failed');
    });
  },
);
