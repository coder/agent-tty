import { describe, expect, it } from 'vitest';

import type { ReplayInput } from '../../../src/renderer/types.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';
import {
  GhosttyWebBackend,
  GhosttyWebCrashedError,
} from '../../../src/renderer/ghosttyWeb/index.js';
import { describeReplayFailure } from '../../../src/renderer/ghosttyWeb/crashError.js';

// KNOWN-BUG TESTS for a ghostty-web 0.4.0 fault, upstream issue
// https://github.com/coder/ghostty-web/issues/215. Remove them with
// src/renderer/ghosttyWeb/crashError.ts when a ghostty-web release fixes it.

const CRASHED = new Error('page.evaluate: Target crashed ');

const REPLAY_INPUT: ReplayInput = {
  sessionId: 'renderer-unit-session',
  initialCols: 80,
  initialRows: 24,
  targetSeq: 0,
  events: [
    {
      seq: 0,
      ts: '2026-03-19T12:00:00.000Z',
      type: 'output',
      payload: { data: 'a\u0301\u001bc\u001b[?47ho' },
    },
  ],
};

function createBackendWithFailingWrite(error: Error): GhosttyWebBackend {
  const backend = new GhosttyWebBackend(
    'renderer-unit-session',
    resolveProfile('reference-dark'),
  );
  Object.assign(backend as object, {
    isBooted: true,
    page: { isClosed: () => false },
    resizeBridge: () => Promise.resolve(),
    flushOutputBatch: () => Promise.reject(error),
  });
  return backend;
}

describe('describeReplayFailure', () => {
  it('turns a crashed page into a GhosttyWebCrashedError that keeps the cause', () => {
    const described = describeReplayFailure(CRASHED);

    expect(described).toBeInstanceOf(GhosttyWebCrashedError);
    const crash = described as GhosttyWebCrashedError;
    expect(crash.cause).toBe(CRASHED);
    expect(crash.message).toContain(
      "ghostty-web crashed while it replayed this session's output.",
    );
    expect(crash.message).toContain('(page.evaluate: Target crashed)');
  });

  // The message must be true for every crash. An input without a full reset
  // crashes the page too, so the reset of
  // https://github.com/coder/ghostty-web/issues/215 is one known cause and
  // not the cause.
  it('names the issue as one known cause and says that other inputs crash the page', () => {
    const crash = describeReplayFailure(CRASHED) as GhosttyWebCrashedError;

    expect(crash.message).toContain(
      'One known cause is https://github.com/coder/ghostty-web/issues/215',
    );
    expect(crash.message).toContain('several different inputs');
  });

  it('names the commands that do not use ghostty-web', () => {
    const crash = describeReplayFailure(CRASHED) as GhosttyWebCrashedError;

    expect(crash.message).toContain('libghostty-vt');
    expect(crash.message).toContain('`record export --format svg`');
    expect(crash.message).toContain('`record export --format asciicast`');
  });

  // Real Playwright and harness messages that are not a crash. A looser
  // pattern (`/Target/`, `/crash/i`, `/crashed/`, or one that adds the
  // closed-page text) would call them one and release a healthy page.
  it.each([
    'ghostty-web bridge write() is unavailable',
    'page.evaluate: Target page, context or browser has been closed',
    'page.evaluate: Timeout 30000ms exceeded.',
    'page.evaluate: Error: crash reporter is unavailable',
    'page.evaluate: Error: worker crashed',
  ])('returns the failure "%s" as it is', (message) => {
    const other = new Error(message);

    expect(describeReplayFailure(other)).toBe(other);
  });

  it('returns a value that is not an Error as it is', () => {
    expect(describeReplayFailure('Target crashed')).toBe('Target crashed');
  });
});

describe('GhosttyWebBackend replay of a crashing page', () => {
  it('replayTo rejects with the crash error', async () => {
    const backend = createBackendWithFailingWrite(CRASHED);

    await expect(backend.replayTo(REPLAY_INPUT)).rejects.toBeInstanceOf(
      GhosttyWebCrashedError,
    );
  });

  it('replayWithTiming rejects with the crash error', async () => {
    const backend = createBackendWithFailingWrite(CRASHED);

    await expect(
      backend.replayWithTiming(REPLAY_INPUT, {
        mode: 'max-speed',
        minFrameHoldMs: 0,
        finalFrameHoldMs: 0,
      }),
    ).rejects.toBeInstanceOf(GhosttyWebCrashedError);
  });

  it('keeps another page failure as it is', async () => {
    const failure = new Error('ghostty-web bridge write() is unavailable');
    const backend = createBackendWithFailingWrite(failure);

    await expect(backend.replayTo(REPLAY_INPUT)).rejects.toBe(failure);
  });
});
