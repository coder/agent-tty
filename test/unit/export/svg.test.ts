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

  it('merges background runs into one rect and spans wide-glyph spacers', () => {
    const svg = renderGridFramesToSvg({
      profile: PROFILE,
      frames: [
        makeFrame({
          lines: [
            [
              cell('字', { bg: '#00ff00' }),
              cell('', { bg: '#00ff00' }),
              cell('!', { bg: '#00ff00' }),
            ],
          ],
        }),
      ],
      animate: false,
    });

    // One run covering 3 cells: width 3 x 8.4 = 25.2.
    expect(svg).toContain(
      '<rect x="0" y="0" width="25.2" height="18" fill="#00ff00"/>',
    );
    // The wide glyph's spacer contributes width but no text.
    expect(svg).toContain('>字!</text>');
    expect(svg).toContain('textLength="25.2"');
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

    expect(svg).not.toContain(String(new Date().getFullYear()));
    expect(svg).not.toContain('id=');
  });
});
