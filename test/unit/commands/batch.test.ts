import { describe, expect, it } from 'vitest';

import type { BatchResult } from '../../../src/batch/result.js';

import { buildBatchLines } from '../../../src/cli/commands/batch.js';

describe('buildBatchLines', () => {
  it('labels an interrupted step as interrupted, not as a success', () => {
    // The SIGINT/SIGTERM partial flush marks the in-flight step `interrupted`
    // and later steps `not-run`; the human-readable line must not render those
    // as completed/matched (the bug: an interrupted run printed "completed").
    const result: BatchResult = {
      steps: [
        { index: 0, durationMs: 5, kind: 'type', status: 'completed', seq: 1 },
        {
          index: 1,
          durationMs: 0,
          kind: 'run',
          status: 'interrupted',
          noWait: false,
        },
        { index: 2, durationMs: 0, kind: 'wait', status: 'not-run' },
      ],
      completedCount: 1,
      failedIndices: [],
    };

    const lines = buildBatchLines(result);

    expect(lines[0]).toBe('[0] type completed (5ms)');
    expect(lines[1]).toBe('[1] run interrupted (0ms)');
    expect(lines[2]).toBe('[2] wait not-run (0ms)');
    expect(lines.at(-1)).toBe('1/3 steps completed');
  });
});
