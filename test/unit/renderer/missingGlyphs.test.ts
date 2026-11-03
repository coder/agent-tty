import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
} from '../../../src/renderer/bundledFont.js';
import { profileFontCoverage } from '../../../src/renderer/fontCoverage.js';
import {
  GlyphCheck,
  MAX_MISSING_GLYPH_CELLS,
  buildMissingGlyphs,
  findGlyphCandidates,
  glyphProbeTexts,
  probeUsedFonts,
  type UsedFont,
} from '../../../src/renderer/ghosttyWeb/missingGlyphs.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';
import type { RenderProfileConfig } from '../../../src/renderer/types.js';

const PROFILE = resolveProfile('reference-dark');
const referenceCoverage = profileFontCoverage(PROFILE);
if (referenceCoverage === null) {
  throw new Error('the reference profile must start with a bundled font');
}
const coverage = referenceCoverage;

const JETBRAINS: UsedFont = {
  familyName: 'JetBrains Mono',
  postScriptName: 'JetBrainsMono-Regular',
  isCustomFont: true,
};
const HOST: UsedFont = {
  familyName: 'DejaVu Sans',
  postScriptName: 'DejaVuSans',
  isCustomFont: false,
};

function bundledFace(
  asset: typeof BUNDLED_PRIMARY_FONT_ASSET,
  family: string,
  weight = '400',
) {
  return {
    family,
    assetIdentity: asset.assetIdentity,
    route: asset.route,
    weight,
    style: 'normal' as const,
  };
}

// A page whose CDP reports, for each probe span, the fonts listed for its text.
function fakePage(fonts: Record<string, readonly UsedFont[]>): {
  page: Page;
  probed: string[];
} {
  const fontsByText = new Map(Object.entries(fonts));
  const probed: string[] = [];
  let spans: string[] = [];
  const send = vi.fn((method: string, params?: { nodeId?: number }) => {
    if (method === 'DOM.getDocument') {
      return Promise.resolve({ root: { nodeId: 1 } });
    }
    if (method === 'DOM.querySelectorAll') {
      return Promise.resolve({ nodeIds: spans.map((_, index) => index + 2) });
    }
    if (method === 'CSS.getPlatformFontsForNode') {
      const text = spans[(params?.nodeId ?? 0) - 2] ?? '';
      const used = fontsByText.get(text);
      if (used === undefined) {
        return Promise.reject(new Error(`no fake fonts for ${text}`));
      }
      return Promise.resolve({
        fonts: used.map((font) => ({ ...font, glyphCount: 1 })),
      });
    }
    return Promise.resolve({});
  });
  const page = {
    evaluate: vi.fn((_script: unknown, arg: unknown) => {
      if (typeof arg === 'object' && arg !== null && 'probeTexts' in arg) {
        spans = [...(arg as { probeTexts: string[] }).probeTexts];
        probed.push(...spans);
      }
      return Promise.resolve(0);
    }),
    context: () => ({
      newCDPSession: () =>
        Promise.resolve({ send, detach: () => Promise.resolve() }),
    }),
  } as unknown as Page;
  return { page, probed };
}

function check(profile: RenderProfileConfig = PROFILE): GlyphCheck {
  const glyphCheck = GlyphCheck.forProfile(profile);
  if (glyphCheck === null) {
    throw new Error('the profile must start with a bundled font');
  }
  return glyphCheck;
}

describe('GlyphCheck', () => {
  it('checks a probe against the face that drew it, not every face of its family', async () => {
    const { page } = fakePage({ '\ue0b0': [JETBRAINS] });
    const profile = {
      ...PROFILE,
      fontFamily: '"Term", monospace',
      fontAssets: [
        bundledFace(BUNDLED_PRIMARY_FONT_ASSET, 'Term', '400'),
        bundledFace(BUNDLED_SYMBOLS_FONT_ASSET, 'Term', '700'),
      ],
    };

    await expect(check(profile).screen(page, [['\ue0b0']])).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+E0B0', cells: [{ row: 0, col: 0 }] }],
    });
  });

  it('finds the drawing face by its PostScript name when the profile aliases its family', async () => {
    const { page } = fakePage({ '\u0378': [JETBRAINS] });
    const profile = {
      ...PROFILE,
      fontFamily: '"Term Mono", monospace',
      fontAssets: [bundledFace(BUNDLED_PRIMARY_FONT_ASSET, 'Term Mono')],
    };

    await expect(check(profile).screen(page, [['\u0378']])).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+0378', cells: [{ row: 0, col: 0 }] }],
    });
  });

  it('checks a cluster that the bundled fonts cover only between them', async () => {
    const { page } = fakePage({ '\ue0b0\u0301': [JETBRAINS] });

    await expect(check().screen(page, [['\ue0b0\u0301']])).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+E0B0', cells: [{ row: 0, col: 0 }] }],
    });
  });

  it('never lists a glyph that one bundled font has whole', async () => {
    const { page } = fakePage({ '\ue0b0': [JETBRAINS] });

    await expect(check().screen(page, [['\ue0b0']])).resolves.toEqual({
      missingGlyphs: [],
    });
  });
});

describe('profileFontCoverage', () => {
  it('covers the bundled fonts of the reference profile', () => {
    expect(coverage.firstFamily).toBe('jetbrains mono');
    expect(coverage.union.has(0x41)).toBe(true);
    expect(coverage.union.has(0xe0b0)).toBe(true);
    expect(coverage.union.has(0x29c9)).toBe(false);
    expect(coverage.byFamily.get('jetbrains mono')?.has(0xe0b0)).toBe(false);
  });

  it('returns null when the font stack does not start with a bundled font', () => {
    expect(
      profileFontCoverage({ ...PROFILE, fontFamily: 'monospace' }),
    ).toBeNull();
    expect(
      profileFontCoverage({
        ...PROFILE,
        fontFamily: `monospace, ${PROFILE.fontFamily}`,
      }),
    ).toBeNull();
  });

  it('leaves out bundled fonts that the stack does not name', () => {
    const jetBrainsOnly = profileFontCoverage({
      ...PROFILE,
      fontFamily: '"JetBrains Mono", monospace',
    });

    expect(jetBrainsOnly?.union.has(0x41)).toBe(true);
    expect(jetBrainsOnly?.union.has(0xe0b0)).toBe(false);
    expect([...(jetBrainsOnly?.byFamily.keys() ?? [])]).toEqual([
      'jetbrains mono',
    ]);
  });

  it('matches family names without regard to case, as CSS does', () => {
    const mixedCase = profileFontCoverage({
      ...PROFILE,
      fontFamily: '"jetbrains mono", "SYMBOLS NERD FONT MONO", monospace',
    });
    if (mixedCase === null) {
      throw new Error('a lower-case bundled first family must be found');
    }

    expect(mixedCase.union.has(0xe0b0)).toBe(true);
    expect(
      buildMissingGlyphs(
        findGlyphCandidates([['\u2764\u20dd']], mixedCase.union),
        new Map([['\u2764\u20dd', [JETBRAINS]]]),
        mixedCase,
      ).missingGlyphs.map((glyph) => glyph.codePoint),
    ).toEqual(['U+20DD', 'U+2764']);
  });
});

describe('findGlyphCandidates', () => {
  it('finds nothing on a screen the bundled fonts cover', () => {
    const candidates = findGlyphCandidates(
      [['$', ' ', 'l', 's', '\ue0b0', '', 'é', '…']],
      coverage.union,
    );

    expect([...candidates]).toEqual([]);
  });

  it('groups every cell of an uncovered grapheme and skips wide-glyph spacers', () => {
    const candidates = findGlyphCandidates(
      [['[', '\u29c9', ']'], [], ['\u4e2d', '', '\u29c9']],
      coverage.union,
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
      coverage.union,
    );

    expect([...candidates]).toEqual([]);
  });

  it('counts the spaces that HarfBuzz draws blank as covered', () => {
    const candidates = findGlyphCandidates(
      [['1', '\u202f', '2', '\u2007', '\u2009', '\u205f', '\u3000']],
      coverage.union,
    );

    expect([...candidates]).toEqual([]);
  });

  it('never reports joiners or variation selectors on their own', () => {
    const candidates = findGlyphCandidates(
      [['\u2714\ufe0f', '\u{1f468}\u200d\u{1f469}']],
      coverage.union,
    );

    expect(
      [...candidates.values()].map((candidate) => candidate.codePoints),
    ).toEqual([[0x2714], [0x1f468, 0x1f469]]);
  });
});

describe('glyphProbeTexts', () => {
  it('probes each grapheme and each uncovered code point, a mark on its base', () => {
    const candidates = findGlyphCandidates(
      [['\u{1f600}\u200d\u29c9', '\u29c9', 'a\u1ab0']],
      coverage.union,
    );

    expect(glyphProbeTexts(candidates)).toEqual([
      '\u{1f600}\u200d\u29c9',
      '\u{1f600}',
      '\u29c9',
      'a\u1ab0',
      'a',
    ]);
  });
});

describe('buildMissingGlyphs', () => {
  function report(
    grid: string[][],
    fonts: Record<string, readonly UsedFont[]>,
  ): ReturnType<typeof buildMissingGlyphs> {
    return buildMissingGlyphs(
      findGlyphCandidates(grid, coverage.union),
      new Map(Object.entries(fonts)),
      coverage,
    );
  }

  it('reports what a bundled font drew and nothing a host font drew, in code point order', () => {
    expect(
      report([['\u29c9', '\u2502', '\u0378'], ['\u0378']], {
        '\u29c9': [JETBRAINS],
        '\u2502': [
          {
            familyName: 'DejaVu Sans Mono',
            postScriptName: 'DejaVuSansMono',
            isCustomFont: false,
          },
        ],
        '\u0378': [JETBRAINS],
      }),
    ).toEqual({
      missingGlyphs: [
        {
          codePoint: 'U+0378',
          cells: [
            { row: 0, col: 2 },
            { row: 1, col: 0 },
          ],
        },
        { codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] },
      ],
      truncated: false,
    });
  });

  it('lists every code point that the first font lacks when it drew the whole cluster', () => {
    expect(
      report([['\u2764\u20dd', '\ue0b0\u0302', 'a\u1ab0']], {
        '\u2764\u20dd': [JETBRAINS],
        '\ue0b0\u0302': [JETBRAINS],
        'a\u1ab0': [JETBRAINS],
      }).missingGlyphs.map((glyph) => glyph.codePoint),
    ).toEqual(['U+0302', 'U+1AB0', 'U+20DD', 'U+2764', 'U+E0B0']);
  });

  it('judges a cluster split over a host font and a bundled font per code point', () => {
    expect(
      report([['\u{1f600}\u200d\u29c9']], {
        '\u{1f600}\u200d\u29c9': [HOST, JETBRAINS],
        '\u{1f600}': [HOST],
        '\u29c9': [JETBRAINS],
      }).missingGlyphs,
    ).toEqual([{ codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] }]);
  });

  it('does not list a mark that a host font drew next to a bundled base', () => {
    expect(
      report([['a\u1ab0']], { 'a\u1ab0': [JETBRAINS, HOST], a: [JETBRAINS] })
        .missingGlyphs,
    ).toEqual([]);
  });

  it('lists a mark that the first font drew next to a host-drawn base', () => {
    expect(
      report([['\u{1f600}\u20dd', '\u4e2d\u1ab0']], {
        '\u{1f600}\u20dd': [HOST, JETBRAINS],
        '\u{1f600}': [HOST],
        '\u4e2d\u1ab0': [HOST, JETBRAINS],
        '\u4e2d': [HOST],
      }).missingGlyphs.map((glyph) => glyph.codePoint),
    ).toEqual(['U+1AB0', 'U+20DD']);
  });

  it('counts a probe with no reported font as drawn by the first font', () => {
    expect(report([['\u29c9']], { '\u29c9': [] }).missingGlyphs).toEqual([
      { codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] },
    ]);
  });

  it('marks the report truncated when a probe result is missing', () => {
    expect(report([['\u29c9', '\u0378']], { '\u29c9': [JETBRAINS] })).toEqual({
      missingGlyphs: [{ codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] }],
      truncated: true,
    });
  });

  it('lists at most MAX_MISSING_GLYPH_CELLS cells', () => {
    const result = report(
      [Array.from({ length: MAX_MISSING_GLYPH_CELLS + 5 }, () => '\u0378')],
      { '\u0378': [JETBRAINS] },
    );

    expect(result.truncated).toBe(true);
    expect(result.missingGlyphs[0]?.cells).toHaveLength(
      MAX_MISSING_GLYPH_CELLS,
    );
  });
});

describe('probeUsedFonts', () => {
  function fakePage(count: number, delayMs: number): Page {
    const send = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1 } };
      }
      if (method === 'DOM.querySelectorAll') {
        return { nodeIds: Array.from({ length: count }, (_, i) => i + 2) };
      }
      if (method === 'CSS.getPlatformFontsForNode') {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return {
          fonts: [{ ...JETBRAINS, glyphCount: 1 }],
        };
      }
      return {};
    });
    const session = { send, detach: vi.fn(() => Promise.resolve()) };
    return {
      evaluate: vi.fn(() => Promise.resolve(0)),
      context: () => ({ newCDPSession: () => Promise.resolve(session) }),
    } as unknown as Page;
  }
  const texts = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => String.fromCodePoint(0x4e00 + i));

  it('probes every text when the budget allows', async () => {
    const probed = await probeUsedFonts(fakePage(600, 1), '14px x', texts(600));

    expect(probed.size).toBe(600);
    expect(probed.get('\u4e00')).toEqual([JETBRAINS]);
  });

  it('stops between batches once the time budget is spent', async () => {
    const probed = await probeUsedFonts(
      fakePage(1000, 30),
      '14px x',
      texts(1000),
      40,
    );

    expect(probed.size).toBeGreaterThanOrEqual(256);
    expect(probed.size).toBeLessThan(1000);
    expect(probed.size % 256).toBe(0);
  });
});
