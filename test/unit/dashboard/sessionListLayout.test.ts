import { describe, expect, it } from 'vitest';

import {
  MAX_LIST_WIDTH,
  MIN_LIST_WIDTH,
  formatSessionId,
  listWidthFor,
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
