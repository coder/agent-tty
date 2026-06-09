/**
 * Layout math for the Session Dashboard's panes — the session-list pane and the
 * Live View pane beside (or, when maximized, instead of) it.
 *
 * The list scales with the terminal so that wide screens can show the full
 * 26-char session id (a ULID), while narrow screens fall back to a compact
 * `…last9` form. The width is floored so it stays usable at 80 columns and
 * capped so the Live View keeps the bulk of the screen on very wide terminals.
 */

export const MIN_LIST_WIDTH = 28;
export const MAX_LIST_WIDTH = 40;
const LIST_WIDTH_RATIO = 0.3;

/** Width (columns) of the session-list pane for a given terminal width. */
export function listWidthFor(termCols: number): number {
  const proportional = Math.round(termCols * LIST_WIDTH_RATIO);
  return Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, proportional));
}

// Columns the Live View pane reserves around its own content. Both layouts keep
// the pane's 2-col border (PANE_BORDER) and 2 cols of right-edge slack
// (PANE_RIGHT_SLACK); the split layout additionally spends the list width plus a
// 1-col gap (PANE_LIST_GAP) before the pane. Keeping the border and slack equal
// in both layouts makes the pane's right edge land on the same column whether or
// not it is maximized, so it never jumps when toggling.
export const PANE_BORDER = 2;
export const PANE_RIGHT_SLACK = 2;
export const PANE_LIST_GAP = 1;
const MIN_PANE_COLS = 10;
const MIN_PANE_ROWS = 4;
// Rows the dashboard chrome takes from the pane's content height: the header (1)
// and footer (1) bars, plus the pane box's top/bottom border (2) and its
// one-line status header (1).
const PANE_VERTICAL_CHROME = 5;

/** Content width + height of the Live View pane, with the list width beside it. */
export interface PaneLayout {
  /** Width of the session-list pane (rendered only in the split layout). */
  listWidth: number;
  /** Content width (columns) of the Live View pane. */
  paneCols: number;
  /** Content height (rows) of the Live View pane. */
  paneRows: number;
}

/**
 * Live View pane geometry. The split layout shares the terminal width with the
 * session list; the maximized layout drops the list (and its gap) to span the
 * full width, keeping the same border and right slack so the pane's right edge
 * stays put across the toggle. Height is identical in both layouts.
 */
export function paneLayout(
  termCols: number,
  termRows: number,
  maximized: boolean,
): PaneLayout {
  const listWidth = listWidthFor(termCols);
  const reservedCols = maximized
    ? PANE_BORDER + PANE_RIGHT_SLACK
    : listWidth + PANE_LIST_GAP + PANE_BORDER + PANE_RIGHT_SLACK;
  return {
    listWidth,
    paneCols: Math.max(MIN_PANE_COLS, termCols - reservedCols),
    paneRows: Math.max(MIN_PANE_ROWS, termRows - PANE_VERTICAL_CHROME),
  };
}

/** Compact `…last9` id used when the full id will not fit the list. */
export function shortId(sessionId: string): string {
  return sessionId.length > 10 ? `…${sessionId.slice(-9)}` : sessionId;
}

// Per-row chrome around the id: the `▸ `/`  ` selector (2) + the status dot (1)
// + the spaces flanking the id (2). The full id is shown only when the list is
// wide enough to fit `<chrome><id>` without truncating the id itself.
const ROW_CHROME = 5;

/** The full session id when the list is wide enough, else the short form. */
export function formatSessionId(sessionId: string, listWidth: number): string {
  return listWidth - ROW_CHROME >= sessionId.length
    ? sessionId
    : shortId(sessionId);
}
