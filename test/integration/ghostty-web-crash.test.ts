// KNOWN-BUG TESTS. They pin how agent-tty reports a ghostty-web 0.4.0 fault
// (see src/renderer/ghosttyWeb/crashError.ts). When ghostty-web has a fix,
// bump it and delete this file, or invert it to expect a screenshot.
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
        expect(result.status, args.join(' ')).toBe(9);
        const error = parseError(result.stdout);
        expect(error.code).toBe('RPC_ERROR');
        expect(error.retryable).toBe(true);
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
  },
);
