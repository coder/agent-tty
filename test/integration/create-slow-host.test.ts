import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manifestPath, sessionDir } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  inspectSession,
  processEnds,
  runCli,
  type SuccessEnvelope,
} from '../helpers.js';

// Longer than the 5 s that a create waited for its host before.
const HOST_START_STALL_MS = 8_000;
const preload = (name: string): string =>
  `--import=${pathToFileURL(resolve('test/fixtures', name)).href}`;

let testHome = '';

function createWithSlowHost(env: Record<string, string>, preloads: string[]) {
  return runCli(
    ['create', '--json', '--', '/bin/sh', '-c', 'exec cat'],
    {
      AGENT_TTY_HOME: testHome,
      AGENT_TTY_TEST_HOST_START_STALL_MS: String(HOST_START_STALL_MS),
      ...env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', ...preloads].join(' '),
    },
    90_000,
  );
}

describe.skipIf(process.platform === 'win32')(
  'create with a host that starts slowly',
  { timeout: 120_000 },
  () => {
    beforeEach(async () => {
      testHome = await realpath(
        await mkdtemp(join(tmpdir(), 'agent-tty-slow-host-')),
      );
    });

    afterEach(async () => {
      await cleanupHome(testHome);
    });

    it('waits for a host that is still starting', () => {
      const result = createWithSlowHost({}, [preload('slow-host-start.ts')]);

      expect(result.status).toBe(0);
      const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
        sessionId: string;
      }>;
      expect(envelope.ok).toBe(true);
      const sessionId = envelope.result.sessionId;
      expect(inspectSession(testHome, sessionId)).toMatchObject({
        status: 'running',
      });
      // The create did not fail, so nothing told the host to stop.
      expect(
        existsSync(join(sessionDir(testHome, sessionId), 'create-failed')),
      ).toBe(false);
      expect(
        runCli(['destroy', sessionId, '--json'], { AGENT_TTY_HOME: testHome })
          .status,
      ).toBe(0);
    });

    it('fails at once, with the same error, when the host exits while it starts', async () => {
      const exitFile = join(testHome, 'host-exit-ms');

      const result = createWithSlowHost(
        {
          AGENT_TTY_TEST_HOST_START_EXIT_FILE: exitFile,
        },
        [preload('slow-host-start.ts')],
      );
      const createdEndMs = Date.now();

      // The host ran for longer than a create waited for it before, so the
      // create was still waiting when the host exited.
      expect(existsSync(exitFile)).toBe(true);
      const hostExitMs = Number(await readFile(exitFile, 'utf8'));
      expect(result.status).toBe(6);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: {
          code: string;
          message: string;
          details: { sessionId: string };
        };
      };
      expect(envelope).toMatchObject({
        ok: false,
        error: { code: 'HOST_UNREACHABLE' },
      });
      expect(envelope.error.message).toMatch(/^Failed to reach RPC host at /u);
      const sessionId = envelope.error.details.sessionId;
      // Not at the 30 s deadline of a host that runs and never answers.
      expect(createdEndMs - hostExitMs).toBeLessThan(15_000);
      // The failed create leaves a session that a reconcile ends as failed.
      expect(inspectSession(testHome, sessionId).status).toBe('failed');
      expect(
        runCli(['destroy', sessionId, '--json'], { AGENT_TTY_HOME: testHome })
          .status,
      ).toBe(0);
    });

    it('gives up on a host that runs and never listens, and tells it to stop', async () => {
      // The clock runs 10 times as fast, so the 30 s deadline passes in 3 s.
      const result = createWithSlowHost(
        {
          AGENT_TTY_TEST_HOST_START_STALL_MS: '60000',
          AGENT_TTY_TEST_CLOCK_FACTOR: '10',
        },
        [preload('slow-host-start.ts'), preload('fast-clock.ts')],
      );

      expect(result.status).toBe(6);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string; details: { sessionId: string } };
      };
      expect(envelope).toMatchObject({
        ok: false,
        error: { code: 'HOST_UNREACHABLE' },
      });
      const sessionId = envelope.error.details.sessionId;
      const directory = sessionDir(testHome, sessionId);
      expect(existsSync(join(directory, 'create-failed'))).toBe(true);
      // The SIGTERM of the create ends a host that no handler of its own
      // catches yet.
      const manifest = JSON.parse(
        await readFile(manifestPath(directory), 'utf8'),
      ) as { hostPid: number };
      expect(await processEnds(manifest.hostPid)).toBe(true);
      expect(
        runCli(['destroy', sessionId, '--json'], { AGENT_TTY_HOME: testHome })
          .status,
      ).toBe(0);
    });
  },
);
