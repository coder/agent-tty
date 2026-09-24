import { describe, expect, it } from 'vitest';

import { diffLines } from '../../../src/util/lineDiff.js';

describe('diffLines', () => {
  it('returns all-equal entries for identical inputs', () => {
    const lines = ['a', 'b', 'c'];

    expect(diffLines(lines, lines)).toEqual([
      { op: 'equal', text: 'a', aRow: 0, bRow: 0 },
      { op: 'equal', text: 'b', aRow: 1, bRow: 1 },
      { op: 'equal', text: 'c', aRow: 2, bRow: 2 },
    ]);
  });

  it('reports a replaced line as a delete followed by an add', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { op: 'equal', text: 'a', aRow: 0, bRow: 0 },
      { op: 'delete', text: 'b', aRow: 1 },
      { op: 'add', text: 'x', bRow: 1 },
      { op: 'equal', text: 'c', aRow: 2, bRow: 2 },
    ]);
  });

  it('reports pure insertions and deletions with row indices', () => {
    expect(diffLines(['a', 'c'], ['a', 'b', 'c'])).toEqual([
      { op: 'equal', text: 'a', aRow: 0, bRow: 0 },
      { op: 'add', text: 'b', bRow: 1 },
      { op: 'equal', text: 'c', aRow: 1, bRow: 2 },
    ]);
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual([
      { op: 'equal', text: 'a', aRow: 0, bRow: 0 },
      { op: 'delete', text: 'b', aRow: 1 },
      { op: 'equal', text: 'c', aRow: 2, bRow: 1 },
    ]);
  });

  it('handles empty inputs', () => {
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines([], ['a'])).toEqual([{ op: 'add', text: 'a', bRow: 0 }]);
    expect(diffLines(['a'], [])).toEqual([
      { op: 'delete', text: 'a', aRow: 0 },
    ]);
  });

  it('preserves the longest common subsequence across scrolled screens', () => {
    // Simulates a terminal scrolling by two lines.
    const before = ['line 1', 'line 2', 'line 3', 'line 4'];
    const after = ['line 3', 'line 4', 'line 5', 'line 6'];

    expect(diffLines(before, after)).toEqual([
      { op: 'delete', text: 'line 1', aRow: 0 },
      { op: 'delete', text: 'line 2', aRow: 1 },
      { op: 'equal', text: 'line 3', aRow: 2, bRow: 0 },
      { op: 'equal', text: 'line 4', aRow: 3, bRow: 1 },
      { op: 'add', text: 'line 5', bRow: 2 },
      { op: 'add', text: 'line 6', bRow: 3 },
    ]);
  });

  it('treats repeated identical lines positionally', () => {
    expect(diffLines(['', '', 'x'], ['', 'x', ''])).toEqual([
      { op: 'equal', text: '', aRow: 0, bRow: 0 },
      { op: 'delete', text: '', aRow: 1 },
      { op: 'equal', text: 'x', aRow: 2, bRow: 1 },
      { op: 'add', text: '', bRow: 2 },
    ]);
  });

  it('accepts arbitrarily large single-sided inputs linearly', () => {
    // No per-side cap: a one-sided diff needs no DP table and must not throw.
    const big = new Array<string>(150_000).fill('x');

    const entries = diffLines(big, []);

    expect(entries).toHaveLength(150_000);
    expect(entries.every((entry) => entry.op === 'delete')).toBe(true);
  });

  it('handles a huge one-sided middle without allocating the DP table', () => {
    // 3M distinct rows vs one shared row: the trimmed middle is one-sided,
    // which must bypass the table (3M one-element rows would be ~hundreds of
    // MiB) and complete quickly.
    const a = Array.from({ length: 3_000_000 }, (_, i) => `row ${String(i)}`);
    const b = ['row 0'];

    const started = Date.now();
    const entries = diffLines(a, b);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(entries).toHaveLength(3_000_000);
    expect(entries[0]).toEqual({
      op: 'equal',
      text: 'row 0',
      aRow: 0,
      bRow: 0,
    });
    expect(entries.slice(1).every((entry) => entry.op === 'delete')).toBe(true);
  });

  it('matches large common prefixes and suffixes without a quadratic table', () => {
    // 40k shared lines on each side would need a ~1.6G-cell DP table; the
    // prefix/suffix trim must reduce the middle to the single changed line.
    const shared = Array.from(
      { length: 40_000 },
      (_, i) => `line ${String(i)}`,
    );
    const a = [...shared, 'OLD', ...shared];
    const b = [...shared, 'NEW', ...shared];

    const entries = diffLines(a, b);

    const changed = entries.filter((entry) => entry.op !== 'equal');
    expect(changed).toEqual([
      { op: 'delete', text: 'OLD', aRow: 40_000 },
      { op: 'add', text: 'NEW', bRow: 40_000 },
    ]);
    expect(entries).toHaveLength(a.length + 1);
  });

  it('handles very large distinct middles without exceeding argument limits', () => {
    // Two fully distinct 63k-line screens produce a 126k-entry fallback
    // middle; appending it must not use argument spreading, which would throw
    // RangeError past V8's function-argument limit.
    const a = Array.from({ length: 63_000 }, (_, i) => `a ${String(i)}`);
    const b = Array.from({ length: 63_000 }, (_, i) => `b ${String(i)}`);

    const entries = diffLines(a, b);

    expect(entries).toHaveLength(126_000);
    expect(entries[0]).toEqual({ op: 'delete', text: 'a 0', aRow: 0 });
    expect(entries[125_999]).toEqual({
      op: 'add',
      text: 'b 62999',
      bRow: 62_999,
    });
  });

  it('degrades to a delete-then-add block when the middle exceeds the cell budget', () => {
    // Fully distinct 3000-line sides leave a middle whose DP table (~9M
    // cells) exceeds the 4M budget; the diff must degrade, not fail.
    const a = Array.from({ length: 3_000 }, (_, i) => `a ${String(i)}`);
    const b = Array.from({ length: 3_000 }, (_, i) => `b ${String(i)}`);

    const entries = diffLines(a, b);

    expect(entries).toHaveLength(6_000);
    expect(
      entries.slice(0, 3_000).every((entry) => entry.op === 'delete'),
    ).toBe(true);
    expect(entries.slice(3_000).every((entry) => entry.op === 'add')).toBe(
      true,
    );
    expect(entries[0]).toEqual({ op: 'delete', text: 'a 0', aRow: 0 });
    expect(entries[5_999]).toEqual({ op: 'add', text: 'b 2999', bRow: 2_999 });
  });
});
