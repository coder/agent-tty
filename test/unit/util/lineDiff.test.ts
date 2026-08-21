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

  it('rejects inputs beyond the line limit', () => {
    const big = new Array<string>(10_001).fill('x');
    expect(() => diffLines(big, [])).toThrow(/must not exceed 10000 lines/);
  });

  it('rejects input pairs whose DP table would exceed the cell limit', () => {
    // Each side passes the per-side limit, but the product (2002^2 cells)
    // exceeds the 4M-cell table bound.
    const a = new Array<string>(2_001).fill('a');
    const b = new Array<string>(2_001).fill('b');
    expect(() => diffLines(a, b)).toThrow(
      /product must not exceed 4000000 table cells/,
    );
  });
});
