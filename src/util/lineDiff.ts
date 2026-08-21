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

const MAX_DIFF_LINES = 100_000;
// Bounds the DP table's cell count (each cell is one JS number), keeping
// worst-case memory in the tens of megabytes. When the middle section (after
// common prefix/suffix trimming) would exceed this, the diff degrades to a
// non-minimal delete-then-add block instead of failing: every valid screen
// pair diffs successfully.
const MAX_DIFF_CELLS = 4_000_000;

function lcsEntries(
  a: readonly string[],
  b: readonly string[],
  aOffset: number,
  bOffset: number,
): LineDiffEntry[] {
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
      entries.push({
        op: 'equal',
        text: aText,
        aRow: aOffset + i,
        bRow: bOffset + j,
      });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      entries.push({ op: 'delete', text: aText, aRow: aOffset + i });
      i += 1;
    } else {
      entries.push({ op: 'add', text: bText, bRow: bOffset + j });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    const aText = a[i];
    invariant(aText !== undefined, 'diffLines trailing a line must exist');
    entries.push({ op: 'delete', text: aText, aRow: aOffset + i });
  }
  for (; j < b.length; j += 1) {
    const bText = b[j];
    invariant(bText !== undefined, 'diffLines trailing b line must exist');
    entries.push({ op: 'add', text: bText, bRow: bOffset + j });
  }

  return entries;
}

// Non-minimal but always-valid fallback: delete every a line, add every b
// line. Used only when the trimmed middle would exceed MAX_DIFF_CELLS.
function fallbackEntries(
  a: readonly string[],
  b: readonly string[],
  aOffset: number,
  bOffset: number,
): LineDiffEntry[] {
  const entries: LineDiffEntry[] = [];
  for (const [i, text] of a.entries()) {
    entries.push({ op: 'delete', text, aRow: aOffset + i });
  }
  for (const [j, text] of b.entries()) {
    entries.push({ op: 'add', text, bRow: bOffset + j });
  }
  return entries;
}

/**
 * LCS line diff of two ordered line arrays via dynamic programming.
 * Deterministic: when a delete and an add are both possible, the delete is
 * emitted first. Common prefix and suffix lines are matched directly, so the
 * quadratic DP table only covers the differing middle; if that middle is
 * still larger than MAX_DIFF_CELLS the middle degrades to a non-minimal
 * delete-then-add block rather than failing. Terminal screens are far below
 * every limit in practice.
 */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
): LineDiffEntry[] {
  invariant(
    a.length <= MAX_DIFF_LINES && b.length <= MAX_DIFF_LINES,
    `diffLines inputs must not exceed ${String(MAX_DIFF_LINES)} lines`,
  );

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const entries: LineDiffEntry[] = [];
  for (let k = 0; k < prefix; k += 1) {
    const text = a[k];
    invariant(text !== undefined, 'diffLines prefix line must exist');
    entries.push({ op: 'equal', text, aRow: k, bRow: k });
  }

  const aMiddle = a.slice(prefix, a.length - suffix);
  const bMiddle = b.slice(prefix, b.length - suffix);
  const withinBudget =
    (aMiddle.length + 1) * (bMiddle.length + 1) <= MAX_DIFF_CELLS;
  entries.push(
    ...(withinBudget
      ? lcsEntries(aMiddle, bMiddle, prefix, prefix)
      : fallbackEntries(aMiddle, bMiddle, prefix, prefix)),
  );

  for (let k = 0; k < suffix; k += 1) {
    const aRow = a.length - suffix + k;
    const bRow = b.length - suffix + k;
    const text = a[aRow];
    invariant(text !== undefined, 'diffLines suffix line must exist');
    entries.push({ op: 'equal', text, aRow, bRow });
  }

  return entries;
}
