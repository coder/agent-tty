// KNOWN-BUG TESTS. They pin how agent-tty reports ghostty-web 0.4.0 faults
// (see src/renderer/ghosttyWeb/crashError.ts). Upstream issue of one of them:
// https://github.com/coder/ghostty-web/issues/215. When a ghostty-web release
// fixes them and agent-tty upgrades to it, delete this file, or invert it to
// expect a screenshot.
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { probeLibghosttyVt } from '../../src/renderer/readiness.js';
import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
  type SuccessEnvelope,
} from '../helpers.js';

const CLI_TIMEOUT_MS = 60_000;

// 12 bytes: `a`, U+0301, RIS, `?47h`, `o`. After the reset, ghostty-web 0.4.0
// shows the old cell on the alternate screen, and the `o` over its grapheme
// cluster faults the WASM module. Chromium then kills the page.
const CRASH_OUTPUT = 'a\\u0301\\u001bc\\u001b[?47ho';
const WRITE_CRASH_OUTPUT = `process.stdout.write('${CRASH_OUTPUT}');`;
const hasLibghosttyVt = (await probeLibghosttyVt()).available;
// 693 lines of five combining marks and 75 plain columns. It has no reset, no
// resize and no alternate screen, and it crashes the page too.
const WRITE_PRINT_CRASH_OUTPUT =
  "process.stdout.write(('e\\u0301'.repeat(5) + 'abcdefghij'.repeat(7) + 'abcde' + '\\r\\n').repeat(693));";
const CRASH_EXPLANATION =
  "ghostty-web crashed while it replayed this session's output.";

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

function parseError(stdout: string): ErrorEnvelope['error'] {
  const envelope = JSON.parse(stdout) as ErrorEnvelope;
  expect(envelope.ok).toBe(false);
  return envelope.error;
}

// The page crash is verified with the Playwright Chromium of Linux. Other
// platforms can report the same fault in another way.
describe.skipIf(process.platform !== 'linux')(
  'ghostty-web page crash on RIS + ?47h + grapheme cluster',
  { timeout: 240_000 },
  () => {
    let testHome = '';
    let sessionId = '';

    beforeEach(async () => {
      // oxfmt-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-ghostty-crash-')));
    });

    afterEach(async () => {
      destroySession(testHome, sessionId);
      await cleanupHome(testHome);
      sessionId = '';
      testHome = '';
    });

    it('names the crash when a live screenshot and a live ghostty-web snapshot fail', () => {
      sessionId = createSession(testHome, [
        process.execPath,
        '-e',
        `${WRITE_CRASH_OUTPUT} process.stdin.resume();`,
      ]);
      const env = { AGENT_TTY_HOME: testHome };

      for (const args of [
        ['screenshot', sessionId, '--json'],
        ['snapshot', sessionId, '--renderer', 'ghostty-web', '--json'],
      ]) {
        const result = runCli(args, env, CLI_TIMEOUT_MS);
        expect(result.status, args.join(' ')).toBe(10);
        const error = parseError(result.stdout);
        expect(error.code).toBe('REPLAY_ERROR');
        expect(error.retryable).toBe(false);
        expect(error.message).toContain(CRASH_EXPLANATION);
        expect(error.message).toContain('Target crashed');
      }

      // The host and the session survive, and the default renderer is fine.
      const snapshot = runCli(['snapshot', sessionId, '--json'], env);
      expect(snapshot.status).toBe(0);
      const envelope = JSON.parse(snapshot.stdout) as SuccessEnvelope<{
        visibleLines: { text: string }[];
      }>;
      expect(envelope.result.visibleLines[0]?.text).toBe('o');
    });

    // Counts the host's calls to its renderer, one for each render poll.
    function renderCallLogEnv(renderCallLog: string): Record<string, string> {
      const preload = pathToFileURL(
        resolve('test/fixtures/inject-replay-failure.ts'),
      );
      return {
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS ?? '',
          `--import=${preload.href}`,
        ].join(' '),
        AGENT_TTY_TEST_RENDER_CALL_LOG: renderCallLog,
      };
    }

    async function countRenderCalls(renderCallLog: string): Promise<number> {
      const text = await readFile(renderCallLog, 'utf8').catch(() => '');
      return text.split('\n').filter((line) => line.length > 0).length;
    }

    it('names the crash of an input that has no reset, and ends a live ghostty-web wait at it', async () => {
      const renderCallLog = join(testHome, 'render-calls.log');
      sessionId = createSession(
        testHome,
        [
          process.execPath,
          '-e',
          `${WRITE_PRINT_CRASH_OUTPUT} process.stdin.resume();`,
        ],
        { env: renderCallLogEnv(renderCallLog) },
      );
      const env = { AGENT_TTY_HOME: testHome };

      const snapshot = runCli(
        ['snapshot', sessionId, '--renderer', 'ghostty-web', '--json'],
        env,
        CLI_TIMEOUT_MS,
      );
      expect(snapshot.status).toBe(10);
      const snapshotError = parseError(snapshot.stdout);
      expect(snapshotError.code).toBe('REPLAY_ERROR');
      expect(snapshotError.message).toContain(CRASH_EXPLANATION);
      expect(snapshotError.message).toContain('several different inputs');
      expect(snapshotError.message).toContain(
        'https://github.com/coder/ghostty-web/issues/215',
      );
      expect(snapshotError.message).toContain('Target crashed');

      // The wait gives the same error as the snapshot. It does not poll the
      // crashing page again: each poll replays the log into a new page.
      const callsBeforeWait = await countRenderCalls(renderCallLog);
      const waited = runCli(
        [
          'wait',
          sessionId,
          '--renderer',
          'ghostty-web',
          '--text',
          'NEVER',
          '--timeout',
          '60000',
          '--json',
        ],
        env,
        CLI_TIMEOUT_MS,
      );
      expect(waited.status).toBe(10);
      const waitError = parseError(waited.stdout);
      expect(waitError.code).toBe('REPLAY_ERROR');
      expect(waitError.retryable).toBe(false);
      expect(waitError.message).toBe(snapshotError.message);
      expect((await countRenderCalls(renderCallLog)) - callsBeforeWait).toBe(1);
    });

    it('names the crash in the replay and export errors of an exited session', () => {
      sessionId = createSession(testHome, [
        process.execPath,
        '-e',
        WRITE_CRASH_OUTPUT,
      ]);
      const env = { AGENT_TTY_HOME: testHome };
      const exited = runCli(
        ['wait', sessionId, '--exit', '--timeout-ms', '20000', '--json'],
        env,
        CLI_TIMEOUT_MS,
      );
      expect(exited.status).toBe(0);

      const snapshot = runCli(
        ['snapshot', sessionId, '--renderer', 'ghostty-web', '--json'],
        env,
        CLI_TIMEOUT_MS,
      );
      expect(snapshot.status).toBe(10);
      const replayError = parseError(snapshot.stdout);
      expect(replayError.code).toBe('REPLAY_ERROR');
      expect(replayError.message).toMatch(
        /^Failed to boot or replay renderer for session \w+\. ghostty-web crashed while it replayed this session's output\./u,
      );

      const exported = runCli(
        [
          'record',
          'export',
          sessionId,
          '--format',
          'webm',
          '--out',
          join(testHome, 'crash.webm'),
          '--json',
        ],
        env,
        CLI_TIMEOUT_MS,
      );
      expect(exported.status).toBe(7);
      const exportError = parseError(exported.stdout);
      expect(exportError.code).toBe('EXPORT_ERROR');
      expect(exportError.message).toContain(
        `Failed to export session "${sessionId}" as webm. ${CRASH_EXPLANATION}`,
      );
    });

    // A libghostty-vt screenshot replays the log a second time, in a
    // ghostty-web page that it boots for the screenshot. That page crashes too.
    it.skipIf(!hasLibghosttyVt)(
      'reports the crash behind a live libghostty-vt screenshot as REPLAY_ERROR',
      () => {
        sessionId = createSession(testHome, [
          process.execPath,
          '-e',
          `${WRITE_CRASH_OUTPUT} process.stdin.resume();`,
        ]);

        const result = runCli(
          ['screenshot', sessionId, '--renderer', 'libghostty-vt', '--json'],
          { AGENT_TTY_HOME: testHome },
          CLI_TIMEOUT_MS,
        );

        expect(result.status).toBe(10);
        const error = parseError(result.stdout);
        expect(error.code).toBe('REPLAY_ERROR');
        expect(error.retryable).toBe(false);
        expect(error.message).toContain(CRASH_EXPLANATION);
      },
    );

    // The CLI replays the log of an exited session itself. The ghostty-web
    // page of the screenshot crashes after that replay, inside the operation.
    it.skipIf(!hasLibghosttyVt)(
      'reports the crash behind a libghostty-vt screenshot of an exited session as REPLAY_ERROR',
      () => {
        sessionId = createSession(testHome, [
          process.execPath,
          '-e',
          WRITE_CRASH_OUTPUT,
        ]);
        const env = { AGENT_TTY_HOME: testHome };
        const exited = runCli(
          ['wait', sessionId, '--exit', '--timeout-ms', '20000', '--json'],
          env,
          CLI_TIMEOUT_MS,
        );
        expect(exited.status).toBe(0);

        const result = runCli(
          ['screenshot', sessionId, '--renderer', 'libghostty-vt', '--json'],
          env,
          CLI_TIMEOUT_MS,
        );

        expect(result.status).toBe(10);
        const error = parseError(result.stdout);
        expect(error.code).toBe('REPLAY_ERROR');
        expect(error.retryable).toBe(false);
        expect(error.message).toMatch(
          /^Failed to boot or replay renderer for session \w+\. ghostty-web crashed while it replayed this session's output\./u,
        );
      },
    );
  },
);
