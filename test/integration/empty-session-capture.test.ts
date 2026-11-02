import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ScreenshotResult,
  SnapshotResult,
  WaitForRenderResult,
} from '../../src/protocol/messages.js';
import { probeLibghosttyVt } from '../../src/renderer/readiness.js';
import {
  cleanupHome,
  crashSession,
  createSession,
  destroySession,
  inspectSession,
  readEvents,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

const COLS = 40;
const ROWS = 12;
const CLI_TIMEOUT_MS = 60_000;
const hasLibghosttyVt = (await probeLibghosttyVt()).available;
const RENDERERS = hasLibghosttyVt
  ? (['ghostty-web', 'libghostty-vt'] as const)
  : (['ghostty-web'] as const);

function runJson<TResult>(
  testHome: string,
  args: string[],
): { status: number | null; envelope: SuccessEnvelope<TResult> } {
  const result = runCli(
    [...args, '--json'],
    { AGENT_TTY_HOME: testHome },
    CLI_TIMEOUT_MS,
  );
  expect(result.stderr).toBe('');
  return {
    status: result.status,
    envelope: JSON.parse(result.stdout) as SuccessEnvelope<TResult>,
  };
}

function expectBlankSnapshot(result: SnapshotResult): void {
  expect(result.capturedAtSeq).toBe(-1);
  expect(result.cols).toBe(COLS);
  expect(result.rows).toBe(ROWS);
  if (result.format === 'text') {
    expect(result.text.trim()).toBe('');
    return;
  }
  expect(result.visibleLines).toHaveLength(ROWS);
  expect(result.visibleLines.every((line) => line.text === '')).toBe(true);
}

describe(
  'capture on a session that has printed nothing',
  { timeout: 180_000 },
  () => {
    let testHome = '';
    let sessionId = '';

    beforeEach(async () => {
      // oxfmt-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-empty-session-')));
      sessionId = createSession(testHome, ['/bin/sh', '-c', 'exec cat'], {
        cols: COLS,
        rows: ROWS,
      });
      expect(await readEvents(testHome, sessionId)).toEqual([]);
    }, 30_000);

    afterEach(async () => {
      destroySession(testHome, sessionId);
      await cleanupHome(testHome);
      sessionId = '';
      testHome = '';
    });

    it.each(RENDERERS)(
      'snapshots an empty screen of the session size with %s',
      (renderer) => {
        for (const format of ['structured', 'text'] as const) {
          const { status, envelope } = runJson<SnapshotResult>(testHome, [
            'snapshot',
            sessionId,
            '--renderer',
            renderer,
            '--format',
            format,
          ]);
          expect(status).toBe(0);
          expect(envelope.ok).toBe(true);
          expectBlankSnapshot(envelope.result);
        }
      },
    );

    it.each(RENDERERS)(
      'captures a blank screenshot of the session size with %s',
      async (renderer) => {
        const { status, envelope } = runJson<ScreenshotResult>(testHome, [
          'screenshot',
          sessionId,
          '--renderer',
          renderer,
        ]);
        expect(status).toBe(0);
        expect(envelope.ok).toBe(true);
        expect(envelope.result.capturedAtSeq).toBe(-1);
        expect(envelope.result.cols).toBe(COLS);
        expect(envelope.result.rows).toBe(ROWS);

        const clearedId = createSession(
          testHome,
          ['/bin/sh', '-c', "printf '\\033[2J\\033[H'; exec cat"],
          { cols: COLS, rows: ROWS },
        );
        try {
          const deadline = Date.now() + 10_000;
          while (
            (await readEvents(testHome, clearedId)).length === 0 &&
            Date.now() < deadline
          ) {
            await sleep(100);
          }
          const cleared = runJson<ScreenshotResult>(testHome, [
            'screenshot',
            clearedId,
            '--renderer',
            renderer,
          ]);
          expect(cleared.status).toBe(0);
          expect(cleared.envelope.result.capturedAtSeq).toBe(0);
          expect(envelope.result.sha256).toBeDefined();
          expect(envelope.result.sha256).toBe(cleared.envelope.result.sha256);
        } finally {
          destroySession(testHome, clearedId);
        }
      },
    );

    it('matches a screen-stable render wait on the empty screen', () => {
      const { status, envelope } = runJson<WaitForRenderResult>(testHome, [
        'wait',
        sessionId,
        '--screen-stable-ms',
        '300',
        '--timeout-ms',
        '20000',
      ]);
      expect(status).toBe(0);
      expect(envelope.result).toMatchObject({
        matched: true,
        timedOut: false,
        capturedAtSeq: -1,
      });
    });

    function restartWithDelayedOutput(): void {
      destroySession(testHome, sessionId);
      sessionId = createSession(
        testHome,
        ['/bin/sh', '-c', 'sleep 6; echo ready; exec cat'],
        { cols: COLS, rows: ROWS },
      );
    }

    it('keeps a render wait started before the first output alive until it prints', () => {
      restartWithDelayedOutput();

      const { status, envelope } = runJson<WaitForRenderResult>(testHome, [
        'wait',
        sessionId,
        '--text',
        'ready',
        '--timeout-ms',
        '30000',
      ]);
      expect(status).toBe(0);
      expect(envelope.result).toMatchObject({ matched: true, timedOut: false });
    });

    it('chains an empty snapshot capturedAtSeq into wait --after-seq', () => {
      restartWithDelayedOutput();

      const baseline = runJson<SnapshotResult>(testHome, [
        'snapshot',
        sessionId,
      ]);
      expect(baseline.status).toBe(0);
      expect(baseline.envelope.result.capturedAtSeq).toBe(-1);

      const { status, envelope } = runJson<WaitForRenderResult>(testHome, [
        'wait',
        sessionId,
        '--text',
        'ready',
        '--after-seq',
        String(baseline.envelope.result.capturedAtSeq),
        '--timeout-ms',
        '30000',
      ]);
      expect(status).toBe(0);
      expect(envelope.result).toMatchObject({ matched: true, timedOut: false });
      expect(envelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
    });

    it.each(RENDERERS)(
      'snapshots and screenshots an empty screen offline after host death with %s',
      async (renderer) => {
        crashSession(testHome, sessionId);
        const deadline = Date.now() + 10_000;
        while (
          inspectSession(testHome, sessionId).status === 'running' &&
          Date.now() < deadline
        ) {
          await sleep(200);
        }
        expect(inspectSession(testHome, sessionId).status).toBe('failed');
        expect(await readEvents(testHome, sessionId)).toEqual([]);

        const snapshot = runJson<SnapshotResult>(testHome, [
          'snapshot',
          sessionId,
          '--renderer',
          renderer,
        ]);
        expect(snapshot.status).toBe(0);
        expectBlankSnapshot(snapshot.envelope.result);

        const screenshot = runJson<ScreenshotResult>(testHome, [
          'screenshot',
          sessionId,
          '--renderer',
          renderer,
        ]);
        expect(screenshot.status).toBe(0);
        expect(screenshot.envelope.result.capturedAtSeq).toBe(-1);
      },
    );
  },
);
