import { describe, expect, it } from 'vitest';

import type { ReplayInput } from '../../../src/renderer/types.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';
import {
  GhosttyWebBackend,
  GhosttyWebCrashedError,
} from '../../../src/renderer/ghosttyWeb/index.js';
import { describeReplayFailure } from '../../../src/renderer/ghosttyWeb/crashError.js';

// KNOWN-BUG TESTS for a ghostty-web 0.4.0 fault. Remove them with
// src/renderer/ghosttyWeb/crashError.ts when ghostty-web has a fix.

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

  it('returns every other failure as it is', () => {
    const other = new Error('ghostty-web bridge write() is unavailable');

    expect(describeReplayFailure(other)).toBe(other);
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
