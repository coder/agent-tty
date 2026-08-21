import { invariant } from './assert.js';

/**
 * One line of an LCS-based line diff between two screens.
 *
 * - `equal`: the line is present in both screens (`aRow` and `bRow` set).
 * - `delete`: the line is only in screen A (`aRow` set).
 * - `add`: the line is only in screen B (`bRow` set).
 *
 * Row indices are 0-based positions in the respective input arrays.
 */
export interface LineDiffEntry {
  readonly op: 'equal' | 'delete' | 'add';
  readonly text: string;
  readonly aRow?: number;
  readonly bRow?: number;
}

const MAX_DIFF_LINES = 10_000;

/**
 * LCS line diff of two ordered line arrays via dynamic programming.
 * Deterministic: when a delete and an add are both possible, the delete is
 * emitted first. Inputs are bounded to keep the O(a.length * b.length) table
 * cheap; terminal screens are far below the limit.
 */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
): LineDiffEntry[] {
  invariant(
    a.length <= MAX_DIFF_LINES && b.length <= MAX_DIFF_LINES,
    `diffLines inputs must not exceed ${String(MAX_DIFF_LINES)} lines`,
  );

  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = lcs[i];
    const nextRow = lcs[i + 1];
    invariant(
      row !== undefined && nextRow !== undefined,
      'diffLines LCS rows must exist',
    );
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const entries: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const aText = a[i];
    const bText = b[j];
    invariant(
      aText !== undefined && bText !== undefined,
      'diffLines lines must exist within bounds',
    );
    if (aText === bText) {
      entries.push({ op: 'equal', text: aText, aRow: i, bRow: j });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      entries.push({ op: 'delete', text: aText, aRow: i });
      i += 1;
    } else {
      entries.push({ op: 'add', text: bText, bRow: j });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    const aText = a[i];
    invariant(aText !== undefined, 'diffLines trailing a line must exist');
    entries.push({ op: 'delete', text: aText, aRow: i });
  }
  for (; j < b.length; j += 1) {
    const bText = b[j];
    invariant(bText !== undefined, 'diffLines trailing b line must exist');
    entries.push({ op: 'add', text: bText, bRow: j });
  }

  return entries;
}
