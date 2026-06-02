import { describe, expect, it } from 'vitest';

import type { SnapshotCell } from '../../../src/protocol/schemas.js';
import type { SemanticSnapshot } from '../../../src/renderer/types.js';
import { projectLiveView } from '../../../src/dashboard/liveViewProjection.js';

interface SnapshotOptions {
  cursorRow?: number;
  cursorCol?: number;
  isAltScreen?: boolean;
  style?: (row: number, col: number, char: string) => Partial<SnapshotCell>;
  includeCells?: boolean;
}

/** Build a SemanticSnapshot from rows of text, with optional per-cell styling. */
function snapshotFromRows(
  rows: string[],
  options: SnapshotOptions = {},
): SemanticSnapshot {
  const cols = Math.max(1, ...rows.map((row) => row.length));
  const includeCells = options.includeCells ?? true;
  const snapshot: SemanticSnapshot = {
    sessionId: 'session',
    capturedAtSeq: 0,
    cols,
    rows: rows.length,
    cursorRow: options.cursorRow ?? 0,
    cursorCol: options.cursorCol ?? 0,
    isAltScreen: options.isAltScreen ?? false,
    visibleLines: rows.map((text, row) => ({ row, text })),
    ...(includeCells
      ? {
          cells: rows.map((text, row) => ({
            lineNumber: row,
            cells: Array.from(text).map((char, col) => ({
              char,
              ...options.style?.(row, col, char),
            })),
          })),
        }
      : {}),
  };
  return snapshot;
}

function chars(view: { cells: { char: string }[][] }): string[] {
  return view.cells.map((row) => row.map((cell) => cell.char).join(''));
}

describe('projectLiveView', () => {
  it('mirrors a screen that exactly fills the pane and flags the cursor cell', () => {
    const snapshot = snapshotFromRows(['abc', 'def'], {
      cursorRow: 0,
      cursorCol: 1,
      style: (_row, col) => (col === 0 ? { fg: '#ff0000' } : {}),
    });

    const view = projectLiveView({
      snapshot,
      pane: { cols: 3, rows: 2 },
      mode: 'one-to-one',
    });

    expect(view.mode).toBe('one-to-one');
    expect(view.cols).toBe(3);
    expect(view.rows).toBe(2);
    expect(chars(view)).toEqual(['abc', 'def']);
    expect(view.pan).toEqual({ row: 0, col: 0 });
    expect(view.truncated).toEqual({
      top: false,
      bottom: false,
      left: false,
      right: false,
    });
    expect(view.cells[0]?.[1]?.cursor).toBe(true);
    expect(view.cells[0]?.[0]?.cursor).toBeUndefined();
    expect(view.cells[0]?.[0]?.fg).toBe('#ff0000');
  });

  it('clips to the top-left and flags right/bottom truncation when larger than the pane', () => {
    const snapshot = snapshotFromRows(['abcd', 'efgh', 'ijkl', 'mnop']);

    const view = projectLiveView({
      snapshot,
      pane: { cols: 2, rows: 2 },
      mode: 'one-to-one',
    });

    expect(view.cols).toBe(2);
    expect(view.rows).toBe(2);
    expect(chars(view)).toEqual(['ab', 'ef']);
    expect(view.truncated).toEqual({
      top: false,
      bottom: true,
      left: false,
      right: true,
    });
  });

  it('pans the clipped window and flags top/left truncation', () => {
    const snapshot = snapshotFromRows(['abcd', 'efgh', 'ijkl', 'mnop']);

    const view = projectLiveView({
      snapshot,
      pane: { cols: 2, rows: 2 },
      mode: 'one-to-one',
      pan: { row: 1, col: 1 },
    });

    expect(chars(view)).toEqual(['fg', 'jk']);
    expect(view.pan).toEqual({ row: 1, col: 1 });
    expect(view.truncated).toEqual({
      top: true,
      bottom: true,
      left: true,
      right: true,
    });
  });

  it('clamps a pan offset that would scroll past the content', () => {
    const snapshot = snapshotFromRows(['abcd', 'efgh', 'ijkl', 'mnop']);

    const view = projectLiveView({
      snapshot,
      pane: { cols: 2, rows: 2 },
      mode: 'one-to-one',
      pan: { row: 99, col: 99 },
    });

    // Clamped to the bottom-right window: max pan = (rows-pane, cols-pane) = (2,2).
    expect(view.pan).toEqual({ row: 2, col: 2 });
    expect(chars(view)).toEqual(['kl', 'op']);
    expect(view.truncated).toEqual({
      top: true,
      bottom: false,
      left: true,
      right: false,
    });
  });

  it('letterboxes a screen smaller than the pane (own size, no truncation, no stretch)', () => {
    const snapshot = snapshotFromRows(['hi', 'yo']);

    const view = projectLiveView({
      snapshot,
      pane: { cols: 10, rows: 6 },
      mode: 'one-to-one',
    });

    expect(view.cols).toBe(2);
    expect(view.rows).toBe(2);
    expect(chars(view)).toEqual(['hi', 'yo']);
    expect(view.truncated).toEqual({
      top: false,
      bottom: false,
      left: false,
      right: false,
    });
  });

  it('downsamples to fit the pane with density block glyphs in overview mode', () => {
    // 4x4 screen, each output cell aggregates a 2x2 block at pane 2x2.
    const snapshot = snapshotFromRows(['XX  ', 'X   ', '    ', '   X']);

    const view = projectLiveView({
      snapshot,
      pane: { cols: 2, rows: 2 },
      mode: 'overview',
    });

    expect(view.mode).toBe('overview');
    expect(view.cols).toBe(2);
    expect(view.rows).toBe(2);
    // top-left block 3/4 filled -> '▓'; bottom-right block 1/4 filled -> '░'.
    expect(chars(view)).toEqual(['▓ ', ' ░']);
    expect(view.pan).toEqual({ row: 0, col: 0 });
    expect(view.truncated).toEqual({
      top: false,
      bottom: false,
      left: false,
      right: false,
    });
  });

  it('falls back to visibleLines text when the snapshot carries no cells', () => {
    const snapshot = snapshotFromRows(['ab', 'cd'], { includeCells: false });
    expect(snapshot.cells).toBeUndefined();

    const view = projectLiveView({
      snapshot,
      pane: { cols: 2, rows: 2 },
      mode: 'one-to-one',
    });

    expect(chars(view)).toEqual(['ab', 'cd']);
    expect(view.cells[0]?.[0]?.fg).toBeUndefined();
  });
});
