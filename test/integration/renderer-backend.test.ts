import { mkdtemp, rm, stat } from 'node:fs/promises';
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
    const visibleText = snapshot.visibleLines.map((line) => line.text).join('\n');

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
    const visibleText = snapshot.visibleLines.map((line) => line.text).join('\n');

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

    const outputDir = await mkdtemp(
      join(tmpdir(), 'agent-terminal-renderer-shot-'),
    );
    const outputPath = join(outputDir, 'renderer.png');

    try {
      const screenshot = await backend.screenshot(outputPath);
      const fileStats = await stat(outputPath);

      expect(screenshot.artifactPath).toBe(outputPath);
      expect(screenshot.pngSizeBytes).toBeGreaterThan(0);
      expect(fileStats.size).toBe(screenshot.pngSizeBytes);
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
