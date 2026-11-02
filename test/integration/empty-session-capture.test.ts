import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

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

function decodePngPixels(png: Buffer): Buffer[] {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect([2, 6]).toContain(data[9]);
      bytesPerPixel = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += length + 12;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bytesPerPixel;
  const pixels: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(
      raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
    );
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? (line[x - bytesPerPixel] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft =
        x >= bytesPerPixel ? (previous[x - bytesPerPixel] ?? 0) : 0;
      let predictor = 0;
      if (filter === 1) {
        predictor = left;
      } else if (filter === 2) {
        predictor = up;
      } else if (filter === 3) {
        predictor = Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        predictor =
          toLeft <= toUp && toLeft <= toUpLeft
            ? left
            : toUp <= toUpLeft
              ? up
              : upLeft;
      } else {
        expect(filter).toBe(0);
      }
      line[x] = ((line[x] ?? 0) + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      pixels.push(line.subarray(x * bytesPerPixel, (x + 1) * bytesPerPixel));
    }
    previous = line;
  }
  return pixels;
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

        const pixels = decodePngPixels(
          await readFile(envelope.result.artifactPath),
        );
        const first = pixels[0];
        expect(first).toBeDefined();
        expect(pixels.every((pixel) => first?.equals(pixel) === true)).toBe(
          true,
        );
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
