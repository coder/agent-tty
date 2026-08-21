import { describe, expect, it } from 'vitest';

import type { SvgGridFrame } from '../../../src/export/svg.js';
import type { SnapshotCell } from '../../../src/protocol/schemas.js';

import { renderGridFramesToSvg } from '../../../src/export/svg.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';

const PROFILE = resolveProfile('reference-dark');

function cell(char: string, style: Partial<SnapshotCell> = {}): SnapshotCell {
  return { char, ...style };
}

function makeFrame(overrides: Partial<SvgGridFrame> = {}): SvgGridFrame {
  return {
    cols: 10,
    rows: 3,
    cursorRow: 0,
    cursorCol: 0,
    lines: [],
    holdMs: 100,
    ...overrides,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Drop the embedded font payload (base64 can contain any digits/letters). */
function stripFontAssets(svg: string): string {
  return svg.replace(/<style>[\s\S]*?<\/style>/u, '');
}

describe('renderGridFramesToSvg', () => {
  it('produces byte-identical output for repeated renders of the same input', () => {
    const frames = [
      makeFrame({
        lines: [[cell('h'), cell('i', { fg: '#ff0000', bold: true })]],
        holdMs: 250,
      }),
      makeFrame({
        lines: [[cell('h'), cell('i'), cell('!')]],
        holdMs: 750,
      }),
    ];

    const first = renderGridFramesToSvg({
      profile: PROFILE,
      frames,
      animate: true,
    });
    const second = renderGridFramesToSvg({
      profile: PROFILE,
      frames,
      animate: true,
    });

    expect(second).toBe(first);
    expect(first).toContain('hi!');
  });

  it('renders profile background and default foreground fill', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ lines: [[cell('x')]] })],
      animate: false,
    });

    expect(svg).toContain('<rect width="100%" height="100%" fill="#1e1e2e"/>');
    expect(svg).toContain('fill="#cdd6f4"');
    // 10 cols x 8.4 = 84, 3 rows x 18 = 54.
    expect(svg).toContain('viewBox="0 0 84 54"');
  });

  it('groups consecutive same-style cells into one positioned text run', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [
            [
              cell('e', { fg: '#ff0000', bold: true }),
              cell('r', { fg: '#ff0000', bold: true }),
              cell('r', { fg: '#ff0000', bold: true }),
              cell(' '),
              cell('o', { italic: true, underline: true }),
              cell('k', { italic: true, underline: true }),
            ],
          ],
        }),
      ],
      animate: false,
    });

    expect(countOccurrences(svg, '<text ')).toBe(2);
    expect(svg).toContain(
      '<text x="0" y="14" textLength="25.2" lengthAdjust="spacingAndGlyphs" xml:space="preserve" fill="#ff0000" font-weight="bold">err</text>',
    );
    // Run starts at col 4 (4 x 8.4 = 33.6) and spans 2 cells (16.8).
    expect(svg).toContain(
      '<text x="33.6" y="14" textLength="16.8" lengthAdjust="spacingAndGlyphs" xml:space="preserve" font-style="italic" text-decoration="underline">ok</text>',
    );
  });

  it('splits wide glyphs into their own runs spanning their spacers', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [
            [
              cell('字', { bg: '#00ff00', width: 2 }),
              cell('', { bg: '#00ff00' }),
              cell('!', { bg: '#00ff00' }),
            ],
          ],
        }),
      ],
      animate: false,
    });

    // Backgrounds group independently of text runs: one continuous rect
    // covers all three same-bg cells (3 x 8.4 = 25.2).
    expect(svg).toContain(
      '<rect x="0" y="0" width="25.2" height="18" fill="#00ff00"/>',
    );
    // The wide glyph's own text run covers its spacer: 2 x 8.4 = 16.8; the
    // following width-1 glyph starts a separate run at col 2.
    expect(svg).toContain(
      '<text x="0" y="14" textLength="16.8" lengthAdjust="spacingAndGlyphs" xml:space="preserve">字</text>',
    );
    expect(svg).toContain(
      '<text x="16.8" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">!</text>',
    );
  });

  it('splits text runs at font-face boundaries', () => {
    // U+E0A0 renders from the symbols face while A/B render from the latin
    // subset; the faces have different natural advances, so a merged run
    // would drift interior glyphs off their columns under uniform scaling.
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ lines: [[cell('A'), cell('\ue0a0'), cell('B')]] })],
      animate: false,
    });

    expect(svg).toContain(
      '<text x="0" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">A</text>',
    );
    expect(svg).toContain(
      '<text x="8.4" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">\ue0a0</text>',
    );
    expect(svg).toContain(
      '<text x="16.8" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">B</text>',
    );
    expect(svg).not.toContain('>A\ue0a0</text>');
    expect(svg).not.toContain('>\ue0a0B</text>');
  });

  it('merges consecutive same-face symbol glyphs into one run', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [[cell('\ue0a0'), cell('\ue0a1'), cell('\ue0a2')]],
        }),
      ],
      animate: false,
    });

    expect(svg).toContain(
      '<text x="0" y="14" textLength="25.2" lengthAdjust="spacingAndGlyphs" xml:space="preserve">\ue0a0\ue0a1\ue0a2</text>',
    );
  });

  it('breaks text runs at styled empty cells while shading their columns', () => {
    // Colored field padding: a bg-styled empty cell between same-style glyphs
    // must not join the text run (B would drift off column 2), but its
    // background must still shade the middle column.
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [
            [
              cell('A', { bg: '#0000ff' }),
              cell('', { bg: '#0000ff' }),
              cell('B', { bg: '#0000ff' }),
            ],
          ],
        }),
      ],
      animate: false,
    });

    expect(svg).toContain(
      '<text x="0" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">A</text>',
    );
    expect(svg).toContain(
      '<text x="16.8" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">B</text>',
    );
    expect(svg).not.toContain('>AB</text>');
    // Continuous background coverage across all three cells.
    expect(svg).toContain(
      '<rect x="0" y="0" width="25.2" height="18" fill="#0000ff"/>',
    );
  });

  it('splits mixed-width content at wide-glyph boundaries', () => {
    // A single merged run would scale advances uniformly, so a fallback font
    // with a different CJK advance ratio would shift interior glyphs off
    // their columns; homogeneous-width runs pin every glyph exactly.
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [[cell('A'), cell('漢', { width: 2 }), cell(''), cell('B')]],
        }),
      ],
      animate: false,
    });

    expect(svg).toContain(
      '<text x="0" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">A</text>',
    );
    expect(svg).toContain(
      '<text x="8.4" y="14" textLength="16.8" lengthAdjust="spacingAndGlyphs" xml:space="preserve">漢</text>',
    );
    expect(svg).toContain(
      '<text x="25.2" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">B</text>',
    );
    expect(svg).not.toContain('>A漢B</text>');
  });

  it('anchors styled glyphs after a default-style wide glyph correctly', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [
            [cell('漢', { width: 2 }), cell(''), cell('B', { bold: true })],
          ],
        }),
      ],
      animate: false,
    });

    // The wide glyph spans 2 cells (16.8); B starts at col 2 (x = 16.8).
    expect(svg).toContain(
      '<text x="0" y="14" textLength="16.8" lengthAdjust="spacingAndGlyphs" xml:space="preserve">漢</text>',
    );
    expect(svg).toContain(
      '<text x="16.8" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve" font-weight="bold">B</text>',
    );
  });

  it('embeds the JetBrains Mono latin subset as a woff2 data URI', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ lines: [[cell('x')]] })],
      animate: false,
    });

    expect(svg).toContain(
      '@font-face{font-family:"JetBrains Mono";src:url(data:font/woff2;base64,',
    );
    expect(svg).toContain('SIL Open Font License 1.1');
  });

  it('embeds the Symbols Nerd Font only when a glyph escapes the latin subset', () => {
    const plainSvg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ lines: [[cell('x')]] })],
      animate: false,
    });
    expect(plainSvg).not.toContain('data:font/ttf');

    // U+26A1 HIGH VOLTAGE SIGN: covered by Symbols Nerd Font Mono but not by
    // the latin-only primary subset.
    const symbolSvg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ lines: [[cell('\u26a1')]] })],
      animate: false,
    });
    expect(symbolSvg).toContain(
      '@font-face{font-family:"Symbols Nerd Font Mono";src:url(data:font/ttf;base64,',
    );

    // U+E0A0 (powerline branch glyph) sits in the BMP Private Use Area.
    const puaSvg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ lines: [[cell('\ue0a0')]] })],
      animate: false,
    });
    expect(puaSvg).toContain(
      '@font-face{font-family:"Symbols Nerd Font Mono";src:url(data:font/ttf;base64,',
    );
  });

  it('preserves columns across zero-style gap padding cells', () => {
    // Cursor-forward gaps (e.g. ESC[10C) surface as unstyled empty cells; the
    // glyph after the gap must render at its true column, not stretched from
    // the gap's first column.
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          cols: 16,
          lines: [[...Array.from({ length: 10 }, () => cell('')), cell('X')]],
        }),
      ],
      animate: false,
    });

    // Col 10 x 8.4 = 84; a single cell spans 8.4.
    expect(svg).toContain(
      '<text x="84" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">X</text>',
    );
  });

  it('breaks runs at interior gaps between same-style glyphs', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [[cell('A'), cell(''), cell(''), cell('B')]],
        }),
      ],
      animate: false,
    });

    expect(svg).toContain(
      '<text x="0" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">A</text>',
    );
    // Col 3 x 8.4 = 25.2.
    expect(svg).toContain(
      '<text x="25.2" y="14" textLength="8.4" lengthAdjust="spacingAndGlyphs" xml:space="preserve">B</text>',
    );
  });

  it('escapes XML special characters and strips control characters', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [[cell('<'), cell('&'), cell('"'), cell("'"), cell('\u0007')]],
        }),
      ],
      animate: false,
    });

    expect(svg).toContain('&lt;&amp;&quot;&apos;');
    expect(svg).not.toContain('\u0007');
  });

  it('draws the cursor as a translucent block at the cursor cell', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ cursorRow: 1, cursorCol: 2 })],
      animate: false,
    });

    expect(svg).toContain(
      '<rect x="16.8" y="18" width="8.4" height="18" fill="#cdd6f4" fill-opacity="0.35"/>',
    );
  });

  it('skips the cursor block when the frame reports a hidden cursor', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ cursorRow: 1, cursorCol: 2, cursorVisible: false })],
      animate: false,
    });

    expect(svg).not.toContain('fill-opacity');
  });

  it('renders only the final frame for still exports', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [[cell('f'), cell('i'), cell('r'), cell('s'), cell('t')]],
        }),
        makeFrame({ lines: [[cell('l'), cell('a'), cell('s'), cell('t')]] }),
      ],
      animate: false,
    });

    expect(svg).toContain('last');
    expect(svg).not.toContain('first');
    expect(svg).not.toContain('<animate');
  });

  it('animates de-duplicated frames with recorded hold key times', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({ lines: [[cell('a')]], holdMs: 100 }),
        makeFrame({ lines: [[cell('b')]], holdMs: 200 }),
        makeFrame({ lines: [[cell('c')]], holdMs: 700 }),
      ],
      animate: true,
    });

    expect(countOccurrences(svg, '<g visibility="hidden">')).toBe(3);
    expect(svg).toContain(
      '<animate attributeName="visibility" values="visible;hidden" keyTimes="0;0.1" dur="1000ms" calcMode="discrete" repeatCount="indefinite"/>',
    );
    expect(svg).toContain(
      '<animate attributeName="visibility" values="hidden;visible;hidden" keyTimes="0;0.1;0.3" dur="1000ms" calcMode="discrete" repeatCount="indefinite"/>',
    );
    expect(svg).toContain(
      '<animate attributeName="visibility" values="hidden;visible" keyTimes="0;0.3" dur="1000ms" calcMode="discrete" repeatCount="indefinite"/>',
    );
  });

  it('keeps keyTimes strictly increasing for tiny holds in long timelines', () => {
    // A 1ms hold inside a 10^9 ms timeline needs more than 6 decimals: with
    // coarser rounding both boundaries collapse to the same keyTime and the
    // frame's recorded transition is dropped.
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({ lines: [[cell('a')]], holdMs: 1 }),
        makeFrame({ lines: [[cell('b')]], holdMs: 999_999_999 }),
      ],
      animate: true,
    });

    expect(svg).toContain('keyTimes="0;0.000000001"');
    const keyTimesLists = [...svg.matchAll(/keyTimes="([^"]+)"/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(keyTimesLists.length).toBeGreaterThan(0);
    for (const list of keyTimesLists) {
      const values = list.split(';').map(Number);
      for (let index = 1; index < values.length; index += 1) {
        expect(values[index]).toBeGreaterThan(values[index - 1] ?? Number.NaN);
      }
    }
  });

  it('renders very large frame counts without exhausting argument limits', () => {
    // Math.max(...spread)/push(...spread) over per-frame arrays throw a
    // RangeError past V8's argument limit (~125k); 200k frames must work.
    const frames: SvgGridFrame[] = Array.from({ length: 200_000 }, () =>
      makeFrame({ cols: 1, rows: 1, holdMs: 1, lines: [] }),
    );

    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames,
      animate: false,
    });

    // 1 col x 8.4 = 8.4, 1 row x 18 = 18.
    expect(svg).toContain('viewBox="0 0 8.4 18"');
  });

  it('renders a single animated frame as static content', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [makeFrame({ lines: [[cell('x')]] })],
      animate: true,
    });

    expect(svg).not.toContain('<animate');
    expect(svg).not.toContain('<g visibility');
    expect(svg).toContain('>x</text>');
  });

  it('contains no wall-clock timestamps or random identifiers', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({ lines: [[cell('a')]], holdMs: 100 }),
        makeFrame({ lines: [[cell('b')]], holdMs: 900 }),
      ],
      animate: true,
    });

    // Base64 font payloads can contain arbitrary digit/letter sequences;
    // assert on the document markup only.
    const markup = stripFontAssets(svg);
    expect(markup).not.toContain(String(new Date().getFullYear()));
    expect(markup).not.toContain('id=');
  });
});
