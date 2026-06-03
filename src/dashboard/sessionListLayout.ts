/**
 * Layout math for the Session Dashboard's session-list pane.
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
