import type { Page } from 'playwright';

import type { MissingGlyph } from '../../protocol/schemas.js';
import type { GhosttyHarnessRichLine } from './harnessDecoding.js';

import { invariant } from '../../util/assert.js';

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const PROBE_ROOT_ID = 'agent-tty-glyph-probe';

interface ProbeElement {
  id: string;
  style: { cssText: string; font: string };
  textContent: string | null;
  readonly offsetWidth: number;
  append(child: ProbeElement): void;
  remove(): void;
}

interface ProbeGlobal {
  document: {
    body: ProbeElement;
    createElement(tagName: 'div' | 'span'): ProbeElement;
    getElementById(id: string): ProbeElement | null;
  };
}

interface GlyphCell {
  row: number;
  col: number;
}

export interface GlyphCandidate {
  codePoints: readonly number[];
  cells: GlyphCell[];
}

function isTextCovered(text: string, coverage: ReadonlySet<number>): boolean {
  for (const char of text) {
    if (
      !DEFAULT_IGNORABLE.test(char) &&
      !coverage.has(char.codePointAt(0) ?? -1)
    ) {
      return false;
    }
  }
  return true;
}

// HarfBuzz composes or decomposes a cluster when the font has the other
// canonical form, so `ẽ` (U+1EBD) draws from `e` + U+0303 and `Å` (U+212B)
// draws from U+00C5.
function isCanonicallyCovered(
  text: string,
  coverage: ReadonlySet<number>,
): boolean {
  return [text, text.normalize('NFC'), text.normalize('NFD')].some((form) =>
    isTextCovered(form, coverage),
  );
}

function uncoveredCodePoints(
  grapheme: string,
  coverage: ReadonlySet<number>,
): number[] {
  if (isCanonicallyCovered(grapheme, coverage)) {
    return [];
  }
  const codePoints = new Set<number>();
  for (const char of grapheme) {
    if (!isCanonicallyCovered(char, coverage)) {
      codePoints.add(char.codePointAt(0) ?? -1);
    }
  }
  return [...codePoints];
}

/**
 * Groups the visible cells whose grapheme the bundled fonts cannot draw, keyed
 * by grapheme. Wide-glyph continuation cells and blanks have an empty `char`
 * and never count.
 */
export function findGlyphCandidates(
  lines: readonly GhosttyHarnessRichLine[],
  coverage: ReadonlySet<number>,
): Map<string, GlyphCandidate> {
  const candidates = new Map<string, GlyphCandidate>();
  const covered = new Set<string>();
  for (const line of lines) {
    line.cells.forEach((cell, col) => {
      const grapheme = cell.char;
      if (grapheme === '' || covered.has(grapheme)) {
        return;
      }
      let candidate = candidates.get(grapheme);
      if (candidate === undefined) {
        const codePoints = uncoveredCodePoints(grapheme, coverage);
        if (codePoints.length === 0) {
          covered.add(grapheme);
          return;
        }
        candidate = { codePoints, cells: [] };
        candidates.set(grapheme, candidate);
      }
      candidate.cells.push({ row: line.lineNumber, col });
    });
  }
  return candidates;
}

function formatCodePoint(codePoint: number): string {
  invariant(
    Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff,
    'code point must be a Unicode scalar value',
  );
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Builds `missingGlyphs` from the candidates that Chromium drew with a bundled
 * font. Chromium draws a cluster that no font covers with the first font of the
 * stack, which is bundled, so that font draws `.notdef` boxes for the
 * uncovered code points.
 */
export function buildMissingGlyphs(
  candidates: ReadonlyMap<string, GlyphCandidate>,
  drawnByBundledFont: ReadonlyMap<string, boolean>,
): MissingGlyph[] {
  const cellsByCodePoint = new Map<number, GlyphCell[]>();
  for (const [grapheme, candidate] of candidates) {
    const bundled = drawnByBundledFont.get(grapheme);
    invariant(bundled !== undefined, 'every candidate must have been probed');
    if (!bundled) {
      continue;
    }
    for (const codePoint of candidate.codePoints) {
      const cells = cellsByCodePoint.get(codePoint) ?? [];
      cells.push(...candidate.cells);
      cellsByCodePoint.set(codePoint, cells);
    }
  }

  return [...cellsByCodePoint]
    .sort(([left], [right]) => left - right)
    .map(([codePoint, cells]) => ({
      codePoint: formatCodePoint(codePoint),
      cells: cells.sort(
        (left, right) => left.row - right.row || left.col - right.col,
      ),
    }));
}

/**
 * Asks Chromium which fonts draw each text in the given CSS font, and returns
 * whether a bundled (web) font drew any of it. A text with no reported font
 * counts as drawn by a bundled font, so a failed probe never hides a box.
 */
export async function probeBundledFontUse(
  page: Page,
  font: string,
  texts: readonly string[],
): Promise<Map<string, boolean>> {
  invariant(texts.length > 0, 'probeBundledFontUse needs at least one text');
  await page.evaluate(
    ({ rootId, cssFont, probeTexts }) => {
      const { document } = globalThis as unknown as ProbeGlobal;
      const root = document.createElement('div');
      root.id = rootId;
      root.style.cssText =
        'position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre';
      for (const text of probeTexts) {
        const span = document.createElement('span');
        span.style.font = cssFont;
        span.textContent = text;
        root.append(span);
      }
      document.body.append(root);
      return root.offsetWidth;
    },
    { rootId: PROBE_ROOT_ID, cssFont: font, probeTexts: [...texts] },
  );

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: `#${PROBE_ROOT_ID} > span`,
    });
    invariant(
      nodeIds.length === texts.length,
      'glyph probe must find one span per text',
    );

    const drawnByBundledFont = new Map<string, boolean>();
    for (const [index, nodeId] of nodeIds.entries()) {
      const text = texts[index];
      invariant(text !== undefined, 'glyph probe text must exist');
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', {
        nodeId,
      });
      drawnByBundledFont.set(
        text,
        fonts.length === 0 || fonts.some((usedFont) => usedFont.isCustomFont),
      );
    }
    return drawnByBundledFont;
  } finally {
    await cdp.detach();
    await page.evaluate((rootId) => {
      const { document } = globalThis as unknown as ProbeGlobal;
      document.getElementById(rootId)?.remove();
    }, PROBE_ROOT_ID);
  }
}
