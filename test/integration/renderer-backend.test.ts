import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProfile } from '../../src/renderer/profiles.js';
import type { ReplayInput } from '../../src/renderer/types.js';
import { GhosttyWebBackend } from '../../src/renderer/ghosttyWeb/index.js';

const PROFILE = resolveProfile('reference-dark');
const SESSION_ID = 'renderer-backend-integration';

function timestampFor(seq: number): string {
  return new Date(Date.UTC(2026, 2, 20, 12, 0, seq)).toISOString();
}

function createReplayInput(
  events: ReplayInput['events'],
  options: {
    initialCols?: number;
    initialRows?: number;
    sessionId?: string;
    targetSeq?: number;
  } = {},
): ReplayInput {
  const targetSeq = options.targetSeq ?? events.at(-1)?.seq ?? -1;

  return {
    sessionId: options.sessionId ?? SESSION_ID,
    initialCols: options.initialCols ?? 80,
    initialRows: options.initialRows ?? 24,
    events,
    targetSeq,
  };
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function visibleTextFromSnapshot(
  snapshot: Awaited<ReturnType<GhosttyWebBackend['snapshot']>>,
): string {
  const visibleText = snapshot.visibleLines.map((line) => line.text).join('\n');
  if (visibleText.length === 0) {
    throw new Error('snapshot visible text must be non-empty');
  }

  return visibleText;
}

async function readValidPngFile(
  outputPath: string,
  label: string,
): Promise<Buffer> {
  const pngBuffer = await readFile(outputPath);
  if (pngBuffer.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length) {
    throw new Error(`${label} must include the PNG signature bytes`);
  }
  if (!pngBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} must start with the PNG signature`);
  }

  return pngBuffer;
}

describe('GhosttyWebBackend integration', { timeout: 120_000 }, () => {
  let backend: GhosttyWebBackend;

  beforeEach(() => {
    backend = new GhosttyWebBackend(SESSION_ID, PROFILE);
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('boots and disposes cleanly', async () => {
    expect(backend.isBooted).toBe(false);

    await backend.boot();

    expect(backend.isBooted).toBe(true);

    await backend.dispose();

    expect(backend.isBooted).toBe(false);
  });

  it('boots custom profiles without a bundled font identity', async () => {
    const customBackend = new GhosttyWebBackend(`${SESSION_ID}-custom`, {
      name: 'custom-no-font-identity',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#000000',
      foregroundColor: '#ffffff',
    });

    try {
      await customBackend.boot();
      expect(customBackend.isBooted).toBe(true);
    } finally {
      await customBackend.dispose();
    }
  });

  it('resolves the browser cache from the original HOME when HOME is isolated before boot', async () => {
    // prettier-ignore
    const isolatedHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-terminal-renderer-home-')));
    const previousHome = process.env.HOME;
    const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (previousHome === undefined) {
      throw new Error(
        'expected HOME to be defined before isolating renderer boot',
      );
    }

    try {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.HOME = isolatedHome;

      await backend.boot();

      expect(backend.isBooted).toBe(true);
      expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
        join(previousHome, '.cache', 'ms-playwright'),
      );
    } finally {
      if (previousBrowsersPath === undefined) {
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      } else {
        process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
      }
      process.env.HOME = previousHome;
      await rm(isolatedHome, { recursive: true, force: true });
    }
  });

  it('replays consecutive output events and flushes batches before target breaks', async () => {
    await backend.boot();

    const replayState = await backend.replayTo(
      createReplayInput(
        [
          {
            seq: 0,
            ts: timestampFor(0),
            type: 'output',
            payload: { data: 'hello ' },
          },
          {
            seq: 1,
            ts: timestampFor(1),
            type: 'output',
            payload: { data: 'from ' },
          },
          {
            seq: 2,
            ts: timestampFor(2),
            type: 'output',
            payload: { data: 'replay\r\n' },
          },
          {
            seq: 3,
            ts: timestampFor(3),
            type: 'output',
            payload: { data: 'should not be applied\r\n' },
          },
        ],
        { targetSeq: 2 },
      ),
    );

    const snapshot = await backend.snapshot();
    const visibleText = snapshot.visibleLines
      .map((line) => line.text)
      .join('\n');

    expect(replayState.lastSeq).toBe(2);
    expect(snapshot.capturedAtSeq).toBe(2);
    expect(visibleText).toContain('hello from replay');
    expect(visibleText).not.toContain('should not be applied');
  });

  it('flushes output batches before resize events and preserves dimensions', async () => {
    await backend.boot();

    const replayState = await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'before resize\r\n' },
        },
        {
          seq: 1,
          ts: timestampFor(1),
          type: 'resize',
          payload: { cols: 40, rows: 12 },
        },
        {
          seq: 2,
          ts: timestampFor(2),
          type: 'output',
          payload: { data: 'after resize\r\n' },
        },
      ]),
    );

    const snapshot = await backend.snapshot();
    const visibleText = snapshot.visibleLines
      .map((line) => line.text)
      .join('\n');

    expect(replayState.lastSeq).toBe(2);
    expect(replayState.cols).toBe(40);
    expect(replayState.rows).toBe(12);
    expect(snapshot.cols).toBe(40);
    expect(snapshot.rows).toBe(12);
    expect(visibleText).toContain('before resize');
    expect(visibleText).toContain('after resize');
  });

  it('ignores non-rendering replay event types without failing', async () => {
    await backend.boot();

    const replayState = await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'before ignored events\r\n' },
        },
        {
          seq: 1,
          ts: timestampFor(1),
          type: 'input_text',
          payload: { data: 'typed text' },
        },
        {
          seq: 2,
          ts: timestampFor(2),
          type: 'input_keys',
          payload: { keys: ['Enter'] },
        },
        {
          seq: 3,
          ts: timestampFor(3),
          type: 'signal',
          payload: { signal: 'SIGUSR1' },
        },
      ]),
    );

    const snapshot = await backend.snapshot();

    expect(replayState.lastSeq).toBe(3);
    expect(
      snapshot.visibleLines.some((line) =>
        line.text.includes('before ignored events'),
      ),
    ).toBe(true);
  });

  it('returns visible text for the current viewport', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'visible text marker\r\nsecond line\r\n' },
        },
      ]),
    );

    const visibleText = await backend.getVisibleText();

    expect(visibleText).toContain('visible text marker');
    expect(visibleText).toContain('second line');
  });

  it('returns no scrollbackLines by default', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'hello\r\n' },
        },
      ]),
    );

    const snapshot = await backend.snapshot();

    expect(snapshot.scrollbackLines).toBeUndefined();
  });

  it('supports includeScrollback snapshots for overflow output', async () => {
    await backend.boot();
    const lines = Array.from(
      { length: 50 },
      (_, index) => `line-${String(index)}\r\n`,
    ).join('');
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: lines },
        },
      ]),
    );

    const snapshot = await backend.snapshot({ includeScrollback: true });

    expect(snapshot.visibleLines.length).toBeGreaterThan(0);
    expect(
      snapshot.visibleLines.some((line) => line.text.includes('line-49')),
    ).toBe(true);

    expect(snapshot.scrollbackLines).toBeDefined();
    const scrollbackLines = snapshot.scrollbackLines;
    if (scrollbackLines === undefined) {
      throw new Error('expected scrollback lines');
    }
    expect(scrollbackLines).not.toHaveLength(0);
    expect(scrollbackLines[0]?.row).toBe(0);
    for (let index = 1; index < scrollbackLines.length; index += 1) {
      expect(scrollbackLines[index]?.row).toBeGreaterThan(
        scrollbackLines[index - 1]?.row ?? -1,
      );
    }
    expect(
      scrollbackLines.length + snapshot.visibleLines.length,
    ).toBeGreaterThanOrEqual(50);
    const allScrollbackText = scrollbackLines
      .map((line) => line.text)
      .join('\n');
    expect(allScrollbackText).toContain('line-0');
  });

  it('recovers state after dispose and re-boot', async () => {
    const expectedText = 'hello from renderer';
    const replayInput = createReplayInput([
      {
        seq: 0,
        ts: timestampFor(0),
        type: 'output',
        payload: { data: `${expectedText}\r\n` },
      },
    ]);
    // prettier-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-terminal-renderer-restart-')));
    const screenshotAPath = join(outputDir, 'renderer-a.png');
    const screenshotBPath = join(outputDir, 'renderer-b.png');

    try {
      expect(backend.isBooted).toBe(false);
      await backend.boot();
      expect(backend.isBooted).toBe(true);

      const replayStateA = await backend.replayTo(replayInput);
      expect(replayStateA.lastSeq).toBe(replayInput.targetSeq);

      const screenshotA = await backend.screenshot(screenshotAPath);
      expect(screenshotA.artifactPath).toBe(screenshotAPath);
      expect(screenshotA.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(screenshotA.pngSizeBytes).toBeGreaterThan(0);
      const screenshotABuffer = await readValidPngFile(
        screenshotAPath,
        'screenshotA PNG',
      );
      expect(screenshotABuffer.length).toBe(screenshotA.pngSizeBytes);

      const snapshotA = await backend.snapshot();
      const visibleTextA = visibleTextFromSnapshot(snapshotA);
      expect(snapshotA.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(visibleTextA).toContain(expectedText);

      await backend.dispose();
      expect(backend.isBooted).toBe(false);

      await backend.boot();
      expect(backend.isBooted).toBe(true);

      const replayStateB = await backend.replayTo(replayInput);
      expect(replayStateB.lastSeq).toBe(replayInput.targetSeq);

      const screenshotB = await backend.screenshot(screenshotBPath);
      expect(screenshotB.artifactPath).toBe(screenshotBPath);
      expect(screenshotB.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(screenshotB.pngSizeBytes).toBeGreaterThan(0);
      const screenshotBBuffer = await readValidPngFile(
        screenshotBPath,
        'screenshotB PNG',
      );
      expect(screenshotBBuffer.length).toBe(screenshotB.pngSizeBytes);

      const snapshotB = await backend.snapshot();
      const visibleTextB = visibleTextFromSnapshot(snapshotB);
      expect(snapshotB.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(visibleTextB).toContain(expectedText);
      expect(visibleTextB).toBe(visibleTextA);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('captures screenshots to disk', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'screenshot marker\r\n' },
        },
      ]),
    );

    // prettier-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-terminal-renderer-shot-')));
    const outputPath = join(outputDir, 'renderer.png');

    try {
      const screenshot = await backend.screenshot(outputPath);
      const fileStats = await stat(outputPath);

      expect(screenshot.artifactPath).toBe(outputPath);
      expect(screenshot.pngSizeBytes).toBeGreaterThan(0);
      expect(fileStats.size).toBe(screenshot.pngSizeBytes);
      expect(screenshot.renderProfileHash).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('allows dispose to be called more than once', async () => {
    await backend.boot();

    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
    expect(backend.isBooted).toBe(false);
  });
});
