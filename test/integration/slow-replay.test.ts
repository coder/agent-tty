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

    // A session whose host replays with the slow-replay fixture and has
    // printed the lines, one event for each line.
    async function createSlowSession(
      command: string[],
      env: Record<string, string>,
      printedEvents: number,
    ): Promise<void> {
      const preload = pathToFileURL(resolve('test/fixtures/slow-replay.ts'));
      sessionId = createSession(testHome, command, {
        env: {
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS ?? '',
            `--import=${preload.href}`,
          ].join(' '),
          AGENT_TTY_TEST_REPLAY_MS_PER_EVENT: String(REPLAY_MS_PER_EVENT),
          ...env,
        },
      });
      await waitForEvents(printedEvents);
    }

    async function waitForEvents(count: number): Promise<void> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const events = await readEvents(testHome, sessionId).catch(() => []);
        if (events.length >= count) {
          return;
        }
        await sleep(250);
      }
      throw new Error('timed out waiting for the printed lines');
    }

    // Prints a line every 20 ms, so that each line is its own event.
    const PRINT_LINES_COMMAND = [
      '/bin/sh',
      '-c',
      `i=0; while [ $i -lt ${String(PRINTED_LINES)} ]; do echo line-$i; i=$((i+1)); sleep 0.02; done; exec cat`,
    ];

    it('answers a screenshot, and a snapshot that waits behind it, while the replay goes on for longer than the client waits', async () => {
      await createSlowSession(PRINT_LINES_COMMAND, {}, PRINTED_LINES);

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

    it('answers a libghostty-vt screenshot, which replays the log in a second renderer, for longer than the client waits', async () => {
      await createSlowSession(PRINT_LINES_COMMAND, {}, PRINTED_LINES);

      const outcome = await runCliAsync(
        testHome,
        ['screenshot', sessionId, '--renderer', 'libghostty-vt'],
        90_000,
      );

      expect(outcome.code, outcome.stdout).toBe(0);
      expect(JSON.parse(outcome.stdout)).toMatchObject({
        ok: true,
        result: { rendererBackend: 'ghostty-web' },
      });
      expect(outcome.elapsedMs).toBeGreaterThan(CLIENT_WAIT_MS);
    });

    it('still ends with HOST_TIMEOUT when the replay stops moving', async () => {
      // The renderer finishes two slices and then stops.
      await createSlowSession(
        PRINT_LINES_COMMAND,
        { AGENT_TTY_TEST_REPLAY_STALL_AFTER_CALLS: '2' },
        PRINTED_LINES,
      );

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

    it('answers a run whose catch-up replay goes on for longer than the client waits', async () => {
      // The host default renderer is ghostty-web, so that the catch-up replay
      // after the run uses the slow backend.
      await createSlowSession(
        ['/bin/bash'],
        {
          AGENT_TTY_RENDERER: 'ghostty-web',
          AGENT_TTY_TEST_REPLAY_MS_PER_EVENT: '100',
          HISTFILE: '/dev/null',
        },
        1,
      );
      const printed = await runCliAsync(
        testHome,
        [
          'run',
          sessionId,
          `for i in $(seq 1 ${String(PRINTED_LINES)}); do echo line-$i; sleep 0.02; done`,
          '--no-wait',
        ],
        30_000,
      );
      expect(printed.code, printed.stdout).toBe(0);
      await waitForEvents(PRINTED_LINES);

      // The command ends at once. The client waits 3 s for it and 10 s more
      // for the host, and the catch-up replay takes 20 s or more.
      const outcome = await runCliAsync(
        testHome,
        ['run', sessionId, 'true', '--timeout', '3000'],
        90_000,
      );

      expect(outcome.code, outcome.stdout).toBe(0);
      expect(JSON.parse(outcome.stdout)).toMatchObject({
        ok: true,
        result: { completed: true },
      });
      expect(outcome.elapsedMs).toBeGreaterThan(13_000);
    });
  },
);
