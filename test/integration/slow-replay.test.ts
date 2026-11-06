import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  readEvents,
  sleep,
} from '../helpers.js';

// The host client gives up after 5 s without a byte from the host.
const CLIENT_WAIT_MS = 5_000;
const PRINTED_LINES = 200;
// With 50 ms for each event, the replay of the lines takes 10 s or more.
const REPLAY_MS_PER_EVENT = 50;

interface CliOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly elapsedMs: number;
}

function runCliAsync(
  testHome: string,
  args: string[],
  timeoutMs: number,
): Promise<CliOutcome> {
  const startedAt = performance.now();
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', './src/cli/main.ts', ...args, '--json'],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_TTY_HOME: testHome },
        timeout: timeoutMs,
      },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolvePromise({
          code: error === null ? 0 : typeof code === 'number' ? code : null,
          stdout,
          elapsedMs: performance.now() - startedAt,
        });
      },
    );
  });
}

describe(
  'live render of a log that the renderer replays slowly',
  { timeout: 180_000 },
  () => {
    let testHome = '';
    let sessionId = '';

    beforeEach(async () => {
      // oxfmt-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-slow-replay-')));
    });

    afterEach(async () => {
      destroySession(testHome, sessionId);
      await cleanupHome(testHome);
      sessionId = '';
      testHome = '';
    });

    async function createSlowSession(
      env: Record<string, string>,
    ): Promise<void> {
      const preload = pathToFileURL(resolve('test/fixtures/slow-replay.ts'));
      sessionId = createSession(
        testHome,
        [
          '/bin/sh',
          '-c',
          `i=0; while [ $i -lt ${String(PRINTED_LINES)} ]; do echo line-$i; i=$((i+1)); sleep 0.02; done; exec cat`,
        ],
        {
          env: {
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS ?? '',
              `--import=${preload.href}`,
            ].join(' '),
            AGENT_TTY_TEST_REPLAY_MS_PER_EVENT: String(REPLAY_MS_PER_EVENT),
            ...env,
          },
        },
      );
      // One event for each line, 20 ms apart, so each is its own event.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const events = await readEvents(testHome, sessionId).catch(() => []);
        if (events.length >= PRINTED_LINES) {
          return;
        }
        await sleep(250);
      }
      throw new Error('timed out waiting for the printed lines');
    }

    it('answers a screenshot, and a snapshot that waits behind it, while the replay goes on for longer than the client waits', async () => {
      await createSlowSession({});

      const screenshot = runCliAsync(
        testHome,
        ['screenshot', sessionId],
        90_000,
      );
      // Starts while the first replay runs, so it waits for it.
      await sleep(1_000);
      const snapshot = runCliAsync(
        testHome,
        ['snapshot', sessionId, '--renderer', 'ghostty-web'],
        90_000,
      );
      const [screenshotOutcome, snapshotOutcome] = await Promise.all([
        screenshot,
        snapshot,
      ]);

      expect(screenshotOutcome.code, screenshotOutcome.stdout).toBe(0);
      expect(screenshotOutcome.elapsedMs).toBeGreaterThan(CLIENT_WAIT_MS);
      expect(snapshotOutcome.code, snapshotOutcome.stdout).toBe(0);
      expect(snapshotOutcome.elapsedMs).toBeGreaterThan(CLIENT_WAIT_MS);
    });

    it('still ends with HOST_TIMEOUT when the replay stops moving', async () => {
      // The renderer finishes two slices and then stops.
      await createSlowSession({ AGENT_TTY_TEST_REPLAY_STALL_AFTER_CALLS: '2' });

      const outcome = await runCliAsync(
        testHome,
        ['screenshot', sessionId],
        90_000,
      );

      expect(outcome.code, outcome.stdout).toBe(5);
      expect(JSON.parse(outcome.stdout)).toMatchObject({
        ok: false,
        error: { code: 'HOST_TIMEOUT' },
      });
      // It waited for the slices, then for 5 s without a byte.
      expect(outcome.elapsedMs).toBeGreaterThan(CLIENT_WAIT_MS);
    });
  },
);
