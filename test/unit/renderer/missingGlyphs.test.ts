import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
} from '../../../src/renderer/bundledFont.js';
import {
  GlyphCheck,
  MAX_GLYPH_PROBES,
  MAX_MISSING_GLYPH_CELLS,
  probeUsedFonts,
  type UsedFont,
} from '../../../src/renderer/ghosttyWeb/missingGlyphs.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';
import type { RenderProfileConfig } from '../../../src/renderer/types.js';

const REFERENCE = resolveProfile('reference-dark');
const PROFILE_WITHOUT_NOTO = {
  ...REFERENCE,
  fontFamily: '"JetBrains Mono", "Symbols Nerd Font Mono", monospace',
};

const JETBRAINS: UsedFont = {
  familyName: 'JetBrains Mono',
  postScriptName: 'JetBrainsMono-Regular',
  isCustomFont: true,
};
const SYMBOLS: UsedFont = {
  familyName: 'Symbols Nerd Font Mono',
  postScriptName: 'SymbolsNFM',
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

function fakePage(
  fontsByText: Record<string, readonly UsedFont[]>,
  fallbackFonts?: readonly UsedFont[],
): { page: Page; probed: string[] } {
  const table = new Map(Object.entries(fontsByText));
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
      const used = table.get(text) ?? fallbackFonts;
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

function check(
  profile: RenderProfileConfig = PROFILE_WITHOUT_NOTO,
): GlyphCheck {
  const glyphCheck = GlyphCheck.forProfile(profile);
  if (glyphCheck === null) {
    throw new Error('the profile must start with a bundled font');
  }
  return glyphCheck;
}

async function listed(
  grid: string[][],
  fonts: Record<string, readonly UsedFont[]>,
  profile: RenderProfileConfig = PROFILE_WITHOUT_NOTO,
): Promise<string[]> {
  const { page } = fakePage(fonts);
  const { missingGlyphs } = await check(profile).screen(page, grid);
  return (missingGlyphs ?? []).map((glyph) => glyph.codePoint);
}

describe('GlyphCheck', () => {
  it('checks a probe against the face that drew it, not every face of its family', async () => {
    const { page } = fakePage({ '\ue0b0': [JETBRAINS] });
    const profile = {
      ...PROFILE_WITHOUT_NOTO,
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
      ...PROFILE_WITHOUT_NOTO,
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

  it('counts a bundled font that the stack names after the generic family', async () => {
    const profile = {
      ...PROFILE_WITHOUT_NOTO,
      fontFamily: '"JetBrains Mono", monospace, "Symbols Nerd Font Mono"',
    };

    expect(
      await listed(
        [['\ue0b0', '\u0378']],
        { '\ue0b0': [SYMBOLS], '\u0378': [JETBRAINS] },
        profile,
      ),
    ).toEqual(['U+0378']);
  });

  it('lets the reference stack draw math and legacy-computing symbols with the Noto fonts', async () => {
    expect(
      await listed(
        [['\u29c9', '\u{1fb00}', '\u0378']],
        { '\u0378': [JETBRAINS] },
        REFERENCE,
      ),
    ).toEqual(['U+0378']);
  });

  it('fails when the page drew with a web font that the profile does not bundle', async () => {
    const other = { ...JETBRAINS, postScriptName: 'OtherMono-Regular' };
    const { page } = fakePage({ '\u0378': [other] });

    await expect(check().screen(page, [['\u0378']])).rejects.toThrow();
  });

  it('matches family names without regard to case, as CSS does', async () => {
    const profile = {
      ...PROFILE_WITHOUT_NOTO,
      fontFamily: '"jetbrains mono", "SYMBOLS NERD FONT MONO", monospace',
    };

    expect(
      await listed(
        [['\u2764\u20dd']],
        { '\u2764\u20dd': [JETBRAINS], '\u2764': [JETBRAINS] },
        profile,
      ),
    ).toEqual(['U+20DD', 'U+2764']);
  });

  it('probes nothing on a screen the bundled fonts cover', async () => {
    const { page, probed } = fakePage({});

    await expect(
      check().screen(page, [
        ['$', ' ', 'l', 's', '\ue0b0', '', 'é', '…'],
        ['\u1ebd', '\u212b', 'e\u0303'],
        ['1', '\u202f', '2', '\u2007', '\u2009', '\u205f', '\u3000'],
      ]),
    ).resolves.toEqual({ missingGlyphs: [] });
    expect(probed).toEqual([]);
  });

  it('groups every cell of an uncovered grapheme and skips wide-glyph spacers', async () => {
    const { page } = fakePage({ '\u29c9': [JETBRAINS], '\u4e2d': [JETBRAINS] });

    await expect(
      check().screen(page, [
        ['[', '\u29c9', ']'],
        [],
        ['\u4e2d', '', '\u29c9'],
      ]),
    ).resolves.toEqual({
      missingGlyphs: [
        {
          codePoint: 'U+29C9',
          cells: [
            { row: 0, col: 1 },
            { row: 2, col: 2 },
          ],
        },
        { codePoint: 'U+4E2D', cells: [{ row: 2, col: 0 }] },
      ],
    });
  });

  it('never probes or reports joiners or variation selectors on their own', async () => {
    const { page, probed } = fakePage({}, [JETBRAINS]);
    const { missingGlyphs } = await check().screen(page, [
      ['\u2714\ufe0f', '\u{1f468}\u200d\u{1f469}'],
    ]);

    expect(probed).toEqual([
      '\u2714\ufe0f',
      '\u2714',
      '\u{1f468}\u200d\u{1f469}',
      '\u{1f468}',
      '\u{1f469}',
    ]);
    expect(missingGlyphs?.map((glyph) => glyph.codePoint)).toEqual([
      'U+2714',
      'U+1F468',
      'U+1F469',
    ]);
  });

  it('probes each grapheme and each uncovered code point, a mark on its base', async () => {
    const { page, probed } = fakePage({}, [JETBRAINS]);
    await check().screen(page, [
      ['\u{1f600}\u200d\u29c9', '\u29c9', 'a\u1ab0'],
    ]);

    expect(probed).toEqual([
      '\u{1f600}\u200d\u29c9',
      '\u{1f600}',
      '\u29c9',
      'a\u1ab0',
      'a',
    ]);
  });

  it('reports what a bundled font drew and nothing a host font drew, in code point order', async () => {
    const { page } = fakePage({
      '\u29c9': [JETBRAINS],
      '\u2502': [
        {
          familyName: 'DejaVu Sans Mono',
          postScriptName: 'DejaVuSansMono',
          isCustomFont: false,
        },
      ],
      '\u0378': [JETBRAINS],
    });

    await expect(
      check().screen(page, [['\u29c9', '\u2502', '\u0378'], ['\u0378']]),
    ).resolves.toEqual({
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
    });
  });

  it('lists every code point that the first font lacks when it drew the whole cluster', async () => {
    expect(
      await listed([['\u2764\u20dd', '\ue0b0\u0302', 'a\u1ab0']], {
        '\u2764\u20dd': [JETBRAINS],
        '\u2764': [JETBRAINS],
        '\ue0b0\u0302': [JETBRAINS],
        '\ue0b0': [SYMBOLS],
        'a\u1ab0': [JETBRAINS],
        a: [JETBRAINS],
      }),
    ).toEqual(['U+0302', 'U+1AB0', 'U+20DD', 'U+2764', 'U+E0B0']);
  });

  it('judges a cluster split over a host font and a bundled font per code point', async () => {
    const { page } = fakePage({
      '\u{1f600}\u200d\u29c9': [HOST, JETBRAINS],
      '\u{1f600}': [HOST],
      '\u29c9': [JETBRAINS],
    });

    await expect(
      check().screen(page, [['\u{1f600}\u200d\u29c9']]),
    ).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+29C9', cells: [{ row: 0, col: 0 }] }],
    });
  });

  it('does not list a mark that a host font drew next to a bundled base', async () => {
    expect(
      await listed([['a\u1ab0']], {
        'a\u1ab0': [JETBRAINS, HOST],
        a: [JETBRAINS],
      }),
    ).toEqual([]);
  });

  it('lists a mark that the first font drew next to a host-drawn base', async () => {
    expect(
      await listed([['\u{1f600}\u20dd', '\u4e2d\u1ab0']], {
        '\u{1f600}\u20dd': [HOST, JETBRAINS],
        '\u{1f600}': [HOST],
        '\u4e2d\u1ab0': [HOST, JETBRAINS],
        '\u4e2d': [HOST],
      }),
    ).toEqual(['U+1AB0', 'U+20DD']);
  });

  it('counts a probe with no reported font as drawn by the first font', async () => {
    expect(await listed([['\u29c9']], { '\u29c9': [] })).toEqual(['U+29C9']);
  });

  it('marks the result truncated when the probe limit leaves a glyph unchecked', async () => {
    const { page } = fakePage({}, [JETBRAINS]);
    const grid = [
      Array.from({ length: MAX_GLYPH_PROBES + 1 }, (_, index) =>
        String.fromCodePoint(0x4e00 + index),
      ),
    ];
    const result = await check().screen(page, grid);

    expect(result.missingGlyphsTruncated).toBe(true);
    expect(result.missingGlyphs).toHaveLength(MAX_GLYPH_PROBES);
  });

  it('lists at most MAX_MISSING_GLYPH_CELLS cells', async () => {
    const { page } = fakePage({ '\u0378': [JETBRAINS] });
    const result = await check().screen(page, [
      Array.from({ length: MAX_MISSING_GLYPH_CELLS + 5 }, () => '\u0378'),
    ]);

    expect(result.missingGlyphsTruncated).toBe(true);
    expect(result.missingGlyphs?.[0]?.cells).toHaveLength(
      MAX_MISSING_GLYPH_CELLS,
    );
  });
});

describe('GlyphCheck.graphemes', () => {
  it('lists each boxed code point once, in code point order and without cells', async () => {
    const { page } = fakePage({
      '\u29c9': [JETBRAINS],
      '\u0378': [JETBRAINS],
      '\u2502': [HOST],
    });

    await expect(
      check().graphemes(
        page,
        new Set(['\u29c9', 'a', '\u2502', '\u0378']),
        true,
      ),
    ).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+0378' }, { codePoint: 'U+29C9' }],
    });
  });

  it('marks the result truncated when the painted graphemes were cut short', async () => {
    const { page } = fakePage({ '\u0378': [JETBRAINS] });

    await expect(
      check().graphemes(page, new Set(['\u0378']), false),
    ).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+0378' }],
      missingGlyphsTruncated: true,
    });
  });

  it('marks the result truncated when the probe limit leaves a glyph unchecked', async () => {
    const { page } = fakePage({}, [JETBRAINS]);
    const graphemes = new Set(
      Array.from({ length: MAX_GLYPH_PROBES + 1 }, (_, index) =>
        String.fromCodePoint(0x4e00 + index),
      ),
    );
    const result = await check().graphemes(page, graphemes, true);

    expect(result.missingGlyphsTruncated).toBe(true);
    expect(result.missingGlyphs).toHaveLength(MAX_GLYPH_PROBES);
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
