import { describe, expect, it } from 'vitest';

import {
  assembleCanonicalLine,
  stripTrailingAsciiSpaces,
  type GhosttyDecodedColumn,
} from '../../../src/renderer/ghosttyWeb/backend.js';

// A decoded column as the ghostty-web harness reads it. `grapheme` mirrors
// wasmTerm.getGraphemeString(row, col). The lib's empty-array fallback
// (node_modules/ghostty-web/dist/ghostty-web.js:
// `getGraphemeString = !g||g.length===0 ? " " : String.fromCodePoint(...g)`)
// suggests a blank yields ' ', but the live engine returns getGrapheme === [0]
// for a blank cell, so the fallback never fires and getGraphemeString actually
// returns String.fromCodePoint(0) === a NUL — confirmed by booting
// both backends over 'hi' (see test/integration/cross-backend-screen-hash).
// assembleCanonicalLine normalizes that lone NUL back to ' ', so the fixtures
// below feed the NUL the engine really emits and assert the normalization.
// `width` mirrors cell.getWidth(): 1 for a normal cell, 2 for a wide glyph's
// lead column, 0 for its trailing spacer column.
type ColumnSpec = GhosttyDecodedColumn;

const BLANK: ColumnSpec = { grapheme: '\u0000', width: 1 };
const SPACER: ColumnSpec = { grapheme: '\u0000', width: 0 };

function wide(grapheme: string): readonly ColumnSpec[] {
  return [{ grapheme, width: 2 }, SPACER];
}

function cell(grapheme: string): ColumnSpec {
  return { grapheme, width: 1 };
}

// Assemble a full line over a fixed-width grid of column specs, padding any
// columns past the supplied cells with blanks (the lib's getCell synthesizes a
// blank width-1 cell out of range).
function assemble(cells: readonly ColumnSpec[], cols: number): string {
  return assembleCanonicalLine(cols, (col) => cells[col] ?? BLANK);
}

describe('assembleCanonicalLine (ghostty-web canonical visible text)', () => {
  it('drops wide-glyph trailing spacers so a CJK row matches the native backend text', () => {
    // Native libghostty-vt pins this exact layout's visibleLines[].text as
    // 'A漢字B' (test/unit/renderer/libghosttyVtBackend.test.ts:301) and its
    // cells[] carries each spacer as '' — so the converged ghostty-web text
    // must NOT inject a space for the spacer columns.
    const row: ColumnSpec[] = [
      cell('A'),
      ...wide('漢'),
      ...wide('字'),
      cell('B'),
    ];
    expect(assemble(row, row.length)).toBe('A漢字B');
  });

  it('drops the emoji wide-glyph spacer while keeping a real trailing-content space', () => {
    // 'rocket 🚀 done' — the 🚀 occupies cols 7-8 (8 is the width-0 spacer),
    // col 9 is a genuine space, then 'done'. Matches the native row layout in
    // libghosttyVtBackend.test.ts.
    const row: ColumnSpec[] = [
      cell('r'),
      cell('o'),
      cell('c'),
      cell('k'),
      cell('e'),
      cell('t'),
      cell(' '),
      ...wide('🚀'),
      cell(' '),
      cell('d'),
      cell('o'),
      cell('n'),
      cell('e'),
    ];
    expect(assemble(row, row.length)).toBe('rocket 🚀 done');
  });

  it('preserves interior blank cells as single spaces', () => {
    const row: ColumnSpec[] = [cell('a'), BLANK, BLANK, cell('b')];
    expect(assemble(row, 4)).toBe('a  b');
  });

  it('right-trims trailing ASCII spaces only, padding out to the full width', () => {
    const row: ColumnSpec[] = [cell('h'), cell('i')];
    expect(assemble(row, 10)).toBe('hi');
  });

  it('keeps non-space trailing whitespace (tab) instead of JS trimEnd', () => {
    const row: ColumnSpec[] = [cell('h'), cell('i'), cell('\t')];
    // A bare trailing tab survives; a following blank ASCII space is trimmed.
    expect(assemble(row, 5)).toBe('hi\t');
  });

  it('preserves a full NFD combining-mark grapheme cluster', () => {
    // NFD 'é' = 'e' + U+0301. getGraphemeString returns the whole cluster for
    // the lead cell; the old getChars() path would have dropped the mark.
    const combined = 'é';
    const row: ColumnSpec[] = [cell(combined), cell('x')];
    expect(assemble(row, 4)).toBe(`${combined}x`);
  });

  it('preserves an emoji ZWJ grapheme cluster', () => {
    // Family emoji built with ZWJ; the harness reads it as one wide grapheme.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const row: ColumnSpec[] = [...wide(family), cell('!')];
    expect(assemble(row, row.length)).toBe(`${family}!`);
  });

  it('returns the empty string for an all-blank line', () => {
    expect(assemble([], 8)).toBe('');
  });

  it('reads exactly cols columns regardless of how many cells are supplied', () => {
    const seen: number[] = [];
    assembleCanonicalLine(6, (col) => {
      seen.push(col);
      return BLANK;
    });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rejects a non-string grapheme', () => {
    expect(() =>
      assembleCanonicalLine(1, () => ({
        grapheme: 42 as unknown as string,
        width: 1,
      })),
    ).toThrow('decoded grapheme must be a string');
  });

  it('rejects a negative or non-integer width', () => {
    expect(() =>
      assembleCanonicalLine(1, () => ({ grapheme: 'a', width: -1 })),
    ).toThrow('decoded cell width must be a non-negative integer');
    expect(() =>
      assembleCanonicalLine(1, () => ({ grapheme: 'a', width: 1.5 })),
    ).toThrow('decoded cell width must be a non-negative integer');
  });
});

describe('stripTrailingAsciiSpaces', () => {
  it('removes only trailing 0x20 spaces', () => {
    expect(stripTrailingAsciiSpaces('abc   ')).toBe('abc');
  });

  it('leaves interior spaces and the string untouched when there is no trailing space', () => {
    expect(stripTrailingAsciiSpaces('a b c')).toBe('a b c');
  });

  it('does not strip a trailing tab or non-breaking space', () => {
    expect(stripTrailingAsciiSpaces('abc\t')).toBe('abc\t');
    expect(stripTrailingAsciiSpaces('abc ')).toBe('abc ');
  });

  it('returns the empty string for an all-space input', () => {
    expect(stripTrailingAsciiSpaces('     ')).toBe('');
  });
});
