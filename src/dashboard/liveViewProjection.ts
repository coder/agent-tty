import type { SnapshotCell } from '../protocol/schemas.js';
import type { SemanticSnapshot } from '../renderer/types.js';

/**
 * Pure projection of a **Semantic Snapshot** into the grid a **Live View**
 * paints. It clips, pans, or downsamples the **Session**'s own screen to fit
 * the dashboard pane; it never reflows or stretches (ADR-aligned: the
 * dashboard never resizes the Session).
 */
export type LiveViewMode = 'one-to-one' | 'overview';

export interface PaneSize {
  cols: number;
  rows: number;
}

export interface PanOffset {
  row: number;
  col: number;
}

export interface ProjectedCell {
  char: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  cursor?: boolean;
}

/** Which edges hide off-screen content (so the shell can show indicators). */
export interface TruncationFlags {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

export interface ProjectedView {
  mode: LiveViewMode;
  /** Painted grid width; may be smaller than the pane (letterbox / overview). */
  cols: number;
  /** Painted grid height; may be smaller than the pane (letterbox / overview). */
  rows: number;
  cells: ProjectedCell[][];
  /** The pan offset actually applied after clamping to the content. */
  pan: PanOffset;
  truncated: TruncationFlags;
}

export interface ProjectLiveViewInput {
  snapshot: SemanticSnapshot;
  pane: PaneSize;
  mode: LiveViewMode;
  pan?: PanOffset;
}

/** Reads styled characters from a snapshot's `cells` (preferred) or text. */
class SnapshotGrid {
  private readonly cellRows: Map<number, ReadonlyArray<ProjectedCell>>;
  private readonly textRows: Map<number, string>;

  constructor(private readonly snapshot: SemanticSnapshot) {
    this.cellRows = new Map(
      (snapshot.cells ?? []).map((line) => [
        line.lineNumber,
        line.cells.map((cell) => toProjectedCell(cell)),
      ]),
    );
    this.textRows = new Map(
      snapshot.visibleLines.map((line) => [line.row, line.text]),
    );
  }

  cellAt(row: number, col: number): ProjectedCell {
    // `SnapshotCell[]` is column-indexed: both renderer backends emit one cell
    // per terminal column and pad an empty spacer for the trailing column of a
    // wide glyph (CJK/emoji), so the array index is the terminal column and the
    // cursor-cell highlight stays aligned past a wide glyph. See
    // coder/agent-tty#112.
    const styled = this.cellRows.get(row)?.[col];
    if (styled !== undefined) {
      return styled.char === '' ? { ...styled, char: ' ' } : styled;
    }
    // Fallback for columns without cell data: index the text by code point.
    // Not display-column-accurate for wide glyphs, but only reached past the
    // last populated cell (typically trailing blanks).
    const char = Array.from(this.textRows.get(row) ?? '')[col] ?? ' ';
    return { char: char === '' ? ' ' : char };
  }
}

function toProjectedCell(cell: SnapshotCell): ProjectedCell {
  return {
    char: cell.char,
    ...(cell.fg === undefined ? {} : { fg: cell.fg }),
    ...(cell.bg === undefined ? {} : { bg: cell.bg }),
    ...(cell.bold === undefined ? {} : { bold: cell.bold }),
    ...(cell.italic === undefined ? {} : { italic: cell.italic }),
    ...(cell.underline === undefined ? {} : { underline: cell.underline }),
    ...(cell.strikethrough === undefined
      ? {}
      : { strikethrough: cell.strikethrough }),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function projectOneToOne(input: ProjectLiveViewInput): ProjectedView {
  const { snapshot, pane } = input;
  const grid = new SnapshotGrid(snapshot);

  const panRow = clamp(
    input.pan?.row ?? 0,
    0,
    Math.max(0, snapshot.rows - pane.rows),
  );
  const panCol = clamp(
    input.pan?.col ?? 0,
    0,
    Math.max(0, snapshot.cols - pane.cols),
  );

  const visibleRows = Math.min(pane.rows, snapshot.rows - panRow);
  const visibleCols = Math.min(pane.cols, snapshot.cols - panCol);

  const cells: ProjectedCell[][] = [];
  for (let row = 0; row < visibleRows; row += 1) {
    const sourceRow = panRow + row;
    const out: ProjectedCell[] = [];
    for (let col = 0; col < visibleCols; col += 1) {
      const sourceCol = panCol + col;
      const cell = grid.cellAt(sourceRow, sourceCol);
      const isCursor =
        sourceRow === snapshot.cursorRow && sourceCol === snapshot.cursorCol;
      out.push(isCursor ? { ...cell, cursor: true } : cell);
    }
    cells.push(out);
  }

  return {
    mode: 'one-to-one',
    cols: visibleCols,
    rows: visibleRows,
    cells,
    pan: { row: panRow, col: panCol },
    truncated: {
      top: panRow > 0,
      bottom: panRow + visibleRows < snapshot.rows,
      left: panCol > 0,
      right: panCol + visibleCols < snapshot.cols,
    },
  };
}

const SHADE_RAMP = ['░', '▒', '▓', '█'] as const;

/** Map block fill density (0..1) to a block glyph; blank when empty. */
function shadeForDensity(density: number): string {
  if (density <= 0) {
    return ' ';
  }
  const index = Math.min(
    SHADE_RAMP.length - 1,
    Math.ceil(density * SHADE_RAMP.length) - 1,
  );
  return SHADE_RAMP[index] ?? '█';
}

function projectOverview(input: ProjectLiveViewInput): ProjectedView {
  const { snapshot, pane } = input;
  const grid = new SnapshotGrid(snapshot);

  const scaleX = Math.max(1, Math.ceil(snapshot.cols / pane.cols));
  const scaleY = Math.max(1, Math.ceil(snapshot.rows / pane.rows));
  const outCols = Math.ceil(snapshot.cols / scaleX);
  const outRows = Math.ceil(snapshot.rows / scaleY);

  const cells: ProjectedCell[][] = [];
  for (let row = 0; row < outRows; row += 1) {
    const out: ProjectedCell[] = [];
    for (let col = 0; col < outCols; col += 1) {
      let filled = 0;
      let total = 0;
      let fg: string | undefined;
      for (let dy = 0; dy < scaleY; dy += 1) {
        const sourceRow = row * scaleY + dy;
        if (sourceRow >= snapshot.rows) {
          break;
        }
        for (let dx = 0; dx < scaleX; dx += 1) {
          const sourceCol = col * scaleX + dx;
          if (sourceCol >= snapshot.cols) {
            break;
          }
          total += 1;
          const cell = grid.cellAt(sourceRow, sourceCol);
          if (cell.char !== ' ' && cell.char !== '') {
            filled += 1;
            if (fg === undefined && cell.fg !== undefined) {
              fg = cell.fg;
            }
          }
        }
      }
      const density = total === 0 ? 0 : filled / total;
      out.push({
        char: shadeForDensity(density),
        ...(fg === undefined ? {} : { fg }),
      });
    }
    cells.push(out);
  }

  return {
    mode: 'overview',
    cols: outCols,
    rows: outRows,
    cells,
    pan: { row: 0, col: 0 },
    truncated: { top: false, bottom: false, left: false, right: false },
  };
}

export function projectLiveView(input: ProjectLiveViewInput): ProjectedView {
  return input.mode === 'overview'
    ? projectOverview(input)
    : projectOneToOne(input);
}
