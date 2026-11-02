import { describe, expect, it } from 'vitest';

import { profileFontCoverage } from '../../../src/renderer/fontCoverage.js';
import {
  MAX_MISSING_GLYPH_CELLS,
  buildMissingGlyphs,
  findGlyphCandidates,
  glyphProbeTexts,
} from '../../../src/renderer/ghosttyWeb/missingGlyphs.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';

const referenceCoverage = profileFontCoverage(resolveProfile('reference-dark'));
if (referenceCoverage === null) {
  throw new Error('the reference profile must start with a bundled font');
}
const coverage = referenceCoverage;

describe('profileFontCoverage', () => {
  it('covers the bundled fonts of the reference profile', () => {
    expect(coverage.has(0x41)).toBe(true);
    expect(coverage.has(0xe0b0)).toBe(true);
    expect(coverage.has(0x29c9)).toBe(false);
  });

  it('returns null when the font stack does not start with a bundled font', () => {
    const profile = resolveProfile('reference-dark');

    expect(
      profileFontCoverage({ ...profile, fontFamily: 'monospace' }),
    ).toBeNull();
    expect(
      profileFontCoverage({
        ...profile,
        fontFamily: `monospace, ${profile.fontFamily}`,
      }),
    ).toBeNull();
  });
});

describe('findGlyphCandidates', () => {
  it('finds nothing on a screen the bundled fonts cover', () => {
    const candidates = findGlyphCandidates(
      [['$', ' ', 'l', 's', '\ue0b0', '', 'é', '…']],
      coverage,
    );

    expect([...candidates]).toEqual([]);
  });

  it('groups every cell of an uncovered grapheme and skips wide-glyph spacers', () => {
    const candidates = findGlyphCandidates(
      [['[', '\u29c9', ']'], [], ['\u4e2d', '', '\u29c9']],
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
      [['\u1ebd', '\u212b', 'e\u0303']],
      coverage,
    );

    expect([...candidates]).toEqual([]);
  });

  it('never reports joiners or variation selectors on their own', () => {
    const candidates = findGlyphCandidates(
      [['\u2714\ufe0f', '\u{1f468}\u200d\u{1f469}']],
      coverage,
    );

    expect(
      [...candidates.values()].map((candidate) => candidate.codePoints),
    ).toEqual([[0x2714], [0x1f468, 0x1f469]]);
  });
});

describe('glyphProbeTexts', () => {
  it('probes each uncovered code point, a combining mark on its base', () => {
    const candidates = findGlyphCandidates(
      [['\u{1f600}\u200d', '\u29c9', 'a\u1ab0', '\u29c9']],
      coverage,
    );

    expect(glyphProbeTexts(candidates)).toEqual([
      '\u{1f600}',
      '\u29c9',
      'a\u1ab0',
    ]);
  });
});

describe('buildMissingGlyphs', () => {
  const candidates = findGlyphCandidates(
    [
      ['\u29c9', '\u2502', '\u0378'],
      ['\u0378', '\u{1f468}\u200d\u{1f469}'],
    ],
    coverage,
  );

  it('reports the code points that a bundled font drew, in code point order', () => {
    const drawnByBundledFont = new Map([
      ['\u29c9', true],
      ['\u2502', false],
      ['\u0378', true],
      ['\u{1f468}', false],
      ['\u{1f469}', true],
    ]);

    expect(buildMissingGlyphs(candidates, drawnByBundledFont)).toEqual({
      missingGlyphs: [
        {
          codePoint: 'U+0378',
          cells: [
            { row: 0, col: 2 },
            { row: 1, col: 0 },
          ],
        },
        { codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] },
        { codePoint: 'U+1F469', cells: [{ row: 1, col: 1 }] },
      ],
      truncated: false,
    });
  });

  it('reports nothing when host fonts drew every candidate', () => {
    const drawnByBundledFont = new Map(
      glyphProbeTexts(candidates).map((text) => [text, false] as const),
    );

    expect(buildMissingGlyphs(candidates, drawnByBundledFont)).toEqual({
      missingGlyphs: [],
      truncated: false,
    });
  });

  it('marks the report truncated when a probe result is missing', () => {
    expect(buildMissingGlyphs(candidates, new Map([['\u29c9', true]]))).toEqual(
      {
        missingGlyphs: [{ codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] }],
        truncated: true,
      },
    );
  });

  it('lists at most MAX_MISSING_GLYPH_CELLS cells', () => {
    const many = findGlyphCandidates(
      [Array.from({ length: MAX_MISSING_GLYPH_CELLS + 5 }, () => '\u0378')],
      coverage,
    );

    const report = buildMissingGlyphs(many, new Map([['\u0378', true]]));

    expect(report.truncated).toBe(true);
    expect(report.missingGlyphs[0]?.cells).toHaveLength(
      MAX_MISSING_GLYPH_CELLS,
    );
  });
});
