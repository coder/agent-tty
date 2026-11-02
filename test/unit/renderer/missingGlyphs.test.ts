import { describe, expect, it } from 'vitest';

import { bundledFontCoverage } from '../../../src/renderer/fontCoverage.js';
import {
  buildMissingGlyphs,
  findGlyphCandidates,
} from '../../../src/renderer/ghosttyWeb/missingGlyphs.js';

function row(lineNumber: number, chars: readonly string[]) {
  return { lineNumber, cells: chars.map((char) => ({ char })) };
}

const coverage = bundledFontCoverage();

describe('findGlyphCandidates', () => {
  it('finds nothing on a screen the bundled fonts cover', () => {
    const candidates = findGlyphCandidates(
      [row(0, ['$', ' ', 'l', 's', '\ue0b0', '', 'é', '…'])],
      coverage,
    );

    expect([...candidates]).toEqual([]);
  });

  it('groups every cell of an uncovered grapheme and skips wide-glyph spacers', () => {
    const candidates = findGlyphCandidates(
      [row(0, ['[', '\u29c9', ']']), row(2, ['\u4e2d', '', '\u29c9'])],
      coverage,
    );

    expect(Object.fromEntries(candidates)).toEqual({
      '\u29c9': {
        codePoints: [0x29c9],
        cells: [
          { row: 0, col: 1 },
          { row: 2, col: 2 },
        ],
      },
      '\u4e2d': { codePoints: [0x4e2d], cells: [{ row: 2, col: 0 }] },
    });
  });

  it('counts canonical equivalents that the bundled fonts can draw as covered', () => {
    const candidates = findGlyphCandidates(
      [row(0, ['\u1ebd', '\u212b', 'e\u0303'])],
      coverage,
    );

    expect([...candidates]).toEqual([]);
  });

  it('never reports joiners or variation selectors on their own', () => {
    const candidates = findGlyphCandidates(
      [row(0, ['\u2714\ufe0f', '\u{1f468}\u200d\u{1f469}'])],
      coverage,
    );

    expect(
      [...candidates.values()].map((candidate) => candidate.codePoints),
    ).toEqual([[0x2714], [0x1f468, 0x1f469]]);
  });
});

describe('buildMissingGlyphs', () => {
  const candidates = findGlyphCandidates(
    [
      row(0, ['\u29c9', '\u2502', '\u0378']),
      row(1, ['\u0378', '\u{1f468}\u200d\u{1f469}']),
    ],
    coverage,
  );

  it('reports the code points of graphemes that a bundled font drew, in code point order', () => {
    const drawnByBundledFont = new Map([
      ['\u29c9', true],
      ['\u2502', false],
      ['\u0378', true],
      ['\u{1f468}\u200d\u{1f469}', true],
    ]);

    expect(buildMissingGlyphs(candidates, drawnByBundledFont)).toEqual([
      {
        codePoint: 'U+0378',
        cells: [
          { row: 0, col: 2 },
          { row: 1, col: 0 },
        ],
      },
      { codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] },
      { codePoint: 'U+1F468', cells: [{ row: 1, col: 1 }] },
      { codePoint: 'U+1F469', cells: [{ row: 1, col: 1 }] },
    ]);
  });

  it('reports nothing when host fonts drew every candidate', () => {
    const drawnByBundledFont = new Map(
      [...candidates.keys()].map((grapheme) => [grapheme, false] as const),
    );

    expect(buildMissingGlyphs(candidates, drawnByBundledFont)).toEqual([]);
  });

  it('rejects a candidate that was never probed', () => {
    expect(() => buildMissingGlyphs(candidates, new Map())).toThrow(
      'every candidate must have been probed',
    );
  });
});
