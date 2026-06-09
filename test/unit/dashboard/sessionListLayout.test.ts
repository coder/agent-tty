import { describe, expect, it } from 'vitest';

import {
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  PANE_BORDER,
  PANE_LIST_GAP,
  PANE_RIGHT_SLACK,
  formatSessionId,
  listWidthFor,
  paneLayout,
  shortId,
} from '../../../src/dashboard/sessionListLayout.js';

// A real-shaped 26-char ULID (what `agent-tty create` mints).
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('session list layout', () => {
  it('scales the list width with the terminal, floored and capped', () => {
    expect(ULID.length).toBe(26);
    // Narrow terminals floor at MIN so the list stays usable at 80 columns.
    expect(listWidthFor(80)).toBe(MIN_LIST_WIDTH);
    expect(listWidthFor(40)).toBe(MIN_LIST_WIDTH);
    // Wide terminals cap at MAX so the Live View keeps the bulk of the width.
    expect(listWidthFor(200)).toBe(MAX_LIST_WIDTH);
    // In between it grows proportionally (≈30%).
    expect(listWidthFor(120)).toBe(36);
    expect(listWidthFor(120)).toBeGreaterThan(listWidthFor(90));
  });

  it('shows the full id only when the list is wide enough, else the short form', () => {
    // Wide list (the cap) fits the full ULID.
    expect(formatSessionId(ULID, MAX_LIST_WIDTH)).toBe(ULID);
    // Exactly wide enough (chrome 5 + 26).
    expect(formatSessionId(ULID, 31)).toBe(ULID);
    // One column short → fall back to the compact form.
    expect(formatSessionId(ULID, 30)).toBe(`…${ULID.slice(-9)}`);
    // The floor width still truncates a full ULID.
    expect(formatSessionId(ULID, MIN_LIST_WIDTH)).toBe(`…${ULID.slice(-9)}`);
  });

  it('short-forms long ids and leaves short ids untouched', () => {
    expect(shortId(ULID)).toBe(`…${ULID.slice(-9)}`);
    expect(shortId(ULID).length).toBe(10);
    expect(shortId('bash')).toBe('bash');
  });
});

describe('live view pane layout', () => {
  it('maximized spans the full width; split shares it with the list + gap', () => {
    const split = paneLayout(120, 40, false);
    const max = paneLayout(120, 40, true);
    expect(split.listWidth).toBe(listWidthFor(120));
    expect(split.paneCols).toBe(
      120 - split.listWidth - PANE_LIST_GAP - PANE_BORDER - PANE_RIGHT_SLACK,
    );
    expect(max.paneCols).toBe(120 - PANE_BORDER - PANE_RIGHT_SLACK);
    expect(max.paneCols).toBeGreaterThan(split.paneCols);
  });

  it("keeps the pane's right edge on the same column across the maximize toggle", () => {
    // Right edge = left offset + border-left + content. Split sits after the
    // list and the gap; maximized sits flush at column 0. The shared border and
    // right slack must make both land on the same column (termCols − slack).
    for (const cols of [80, 120, 200]) {
      const split = paneLayout(cols, 40, false);
      const max = paneLayout(cols, 40, true);
      const splitRight =
        split.listWidth + PANE_LIST_GAP + PANE_BORDER + split.paneCols;
      const maxRight = PANE_BORDER + max.paneCols;
      expect(maxRight).toBe(splitRight);
      expect(maxRight).toBe(cols - PANE_RIGHT_SLACK);
    }
  });

  it('height is identical in both layouts and floored on tiny terminals', () => {
    expect(paneLayout(120, 40, false).paneRows).toBe(
      paneLayout(120, 40, true).paneRows,
    );
    expect(paneLayout(120, 40, false).paneRows).toBe(35); // 40 − 5 chrome rows
    // Floors keep the pane usable even when the terminal is smaller than chrome.
    expect(paneLayout(20, 6, false).paneRows).toBeGreaterThanOrEqual(4);
    expect(paneLayout(20, 6, true).paneCols).toBeGreaterThanOrEqual(10);
  });
});
