import type { Page } from 'playwright';

import type { MissingGlyph } from '../../protocol/schemas.js';
import type { ProfileFontCoverage } from '../fontCoverage.js';

import { invariant } from '../../util/assert.js';

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const COMBINING_MARK = /^\p{M}$/u;
const PROBE_ROOT_ID = 'agent-tty-glyph-probe';
// The report stays far below the 1 MiB RPC response limit, and the probe count
// bounds the CDP round trips of one screenshot.
export const MAX_MISSING_GLYPH_CELLS = 4096;
export const MAX_GLYPH_PROBES = 4096;

interface ProbeElement {
  id: string;
  style: { cssText: string; display: string; font: string };
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

export function findGlyphCandidates(
  grid: readonly (readonly string[])[],
  coverage: ReadonlySet<number>,
): Map<string, GlyphCandidate> {
  const candidates = new Map<string, GlyphCandidate>();
  const covered = new Set<string>();
  grid.forEach((graphemes, row) => {
    graphemes.forEach((grapheme, col) => {
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
      candidate.cells.push({ row, col });
    });
  });
  return candidates;
}

function formatCodePoint(codePoint: number): string {
  invariant(
    Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff,
    'code point must be a Unicode scalar value',
  );
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

// A combining mark on its own draws no glyph, so it is probed on its base.
export function probeText(grapheme: string, codePoint: number): string {
  const base = grapheme.codePointAt(0);
  invariant(base !== undefined, 'probeText needs a non-empty grapheme');
  const char = String.fromCodePoint(codePoint);
  return COMBINING_MARK.test(char) && base !== codePoint
    ? String.fromCodePoint(base) + char
    : char;
}

export function glyphProbeTexts(
  candidates: ReadonlyMap<string, GlyphCandidate>,
): string[] {
  const texts = new Set<string>();
  for (const [grapheme, candidate] of candidates) {
    texts.add(grapheme);
    for (const codePoint of candidate.codePoints) {
      texts.add(probeText(grapheme, codePoint));
    }
  }
  return [...texts];
}

export interface UsedFont {
  familyName: string;
  isCustomFont: boolean;
}

export interface MissingGlyphReport {
  missingGlyphs: MissingGlyph[];
  truncated: boolean;
}

// Chromium draws a cluster with one font: the first stack font that covers
// all of it, or else the first font of the stack, which then draws `.notdef`
// boxes. So the code points of a cluster that one bundled font drew are boxes
// when that font lacks them. A cluster split over several fonts is judged per
// code point.
function boxedCodePoints(
  grapheme: string,
  candidate: GlyphCandidate,
  fontsByText: ReadonlyMap<string, readonly UsedFont[]>,
  coverage: ProfileFontCoverage,
): number[] | undefined {
  const fonts = fontsByText.get(grapheme);
  if (fonts === undefined) {
    return undefined;
  }
  if (fonts.length > 0 && fonts.every((font) => !font.isCustomFont)) {
    return [];
  }
  if (fonts.length <= 1) {
    const family = fonts[0]?.familyName ?? coverage.firstFamily;
    const familyCoverage = coverage.byFamily.get(family);
    invariant(
      familyCoverage !== undefined,
      'a web font in the page must be a bundled font of the stack',
    );
    return uncoveredCodePoints(grapheme, familyCoverage);
  }

  const boxed: number[] = [];
  for (const codePoint of candidate.codePoints) {
    const codePointFonts = fontsByText.get(probeText(grapheme, codePoint));
    if (codePointFonts === undefined) {
      return undefined;
    }
    if (codePointFonts.every((font) => font.isCustomFont)) {
      boxed.push(codePoint);
    }
  }
  return boxed;
}

export function buildMissingGlyphs(
  candidates: ReadonlyMap<string, GlyphCandidate>,
  fontsByText: ReadonlyMap<string, readonly UsedFont[]>,
  coverage: ProfileFontCoverage,
): MissingGlyphReport {
  const cellsByCodePoint = new Map<number, GlyphCell[]>();
  let listedCells = 0;
  let truncated = false;
  for (const [grapheme, candidate] of candidates) {
    const boxed = boxedCodePoints(grapheme, candidate, fontsByText, coverage);
    if (boxed === undefined) {
      truncated = true;
      continue;
    }
    for (const codePoint of boxed) {
      const cells = candidate.cells.slice(
        0,
        MAX_MISSING_GLYPH_CELLS - listedCells,
      );
      if (cells.length < candidate.cells.length) {
        truncated = true;
      }
      if (cells.length === 0) {
        continue;
      }
      listedCells += cells.length;
      cellsByCodePoint.set(codePoint, [
        ...(cellsByCodePoint.get(codePoint) ?? []),
        ...cells,
      ]);
    }
  }

  const missingGlyphs = [...cellsByCodePoint]
    .sort(([left], [right]) => left - right)
    .map(([codePoint, cells]) => ({
      codePoint: formatCodePoint(codePoint),
      cells: cells.sort(
        (left, right) => left.row - right.row || left.col - right.col,
      ),
    }));
  return { missingGlyphs, truncated };
}

export async function probeUsedFonts(
  page: Page,
  font: string,
  texts: readonly string[],
): Promise<Map<string, readonly UsedFont[]>> {
  invariant(texts.length > 0, 'probeUsedFonts needs at least one text');
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
        // Inline spans on one line shape as one run, so a text with no font
        // would pull its neighbors into the first font.
        span.style.display = 'block';
        span.textContent = text;
        root.append(span);
      }
      document.body.append(root);
      // CDP reports no fonts for a span that has not been laid out yet.
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

    const results = await Promise.all(
      nodeIds.map((nodeId) =>
        cdp.send('CSS.getPlatformFontsForNode', { nodeId }),
      ),
    );
    return new Map(
      results.map(({ fonts }, index) => {
        const text = texts[index];
        invariant(text !== undefined, 'glyph probe text must exist');
        const used = fonts.map(({ familyName, isCustomFont }) => ({
          familyName,
          isCustomFont,
        }));
        return [text, used] as const;
      }),
    );
  } finally {
    await page.evaluate((rootId) => {
      const { document } = globalThis as unknown as ProbeGlobal;
      document.getElementById(rootId)?.remove();
    }, PROBE_ROOT_ID);
    await cdp.detach();
  }
}
