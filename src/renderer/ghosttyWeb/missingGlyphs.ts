import type { Page } from 'playwright';

import {
  profileFaces,
  type BundledFace,
  type FamilyFaces,
  type StackFaces,
} from '../fontCoverage.js';
import type { RecordedGlyphFields } from '../backend.js';
import type { RenderProfileConfig, ScreenshotResult } from '../types.js';

import { invariant } from '../../util/assert.js';

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const COMBINING_MARK = /^\p{M}$/u;
// HarfBuzz draws these spaces as blank space when the font lacks them.
const FALLBACK_SPACE = /^[\u00a0\u2000-\u200a\u202f\u205f\u3000]$/u;
const PROBE_ROOT_ID = 'agent-tty-glyph-probe';
// The report stays far below the 1 MiB RPC response limit, and the probe count
// bounds the CDP round trips of one screenshot.
export const MAX_MISSING_GLYPH_CELLS = 4096;
export const MAX_GLYPH_PROBES = 4096;
export const MAX_CACHED_GLYPH_PROBES = 4 * MAX_GLYPH_PROBES;
// 4096 probes took 0.55-0.8 s at load 20-30. The budget keeps the probe pass
// well inside the 5 s screenshot RPC timeout on a slower host.
export const GLYPH_PROBE_BUDGET_MS = 1000;
const GLYPH_PROBE_BATCH = 256;

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

type Has = (codePoint: number) => boolean;

const faceHas =
  (face: BundledFace): Has =>
  (codePoint) =>
    face.coverage.has(codePoint);
const familyHas =
  (family: FamilyFaces): Has =>
  (codePoint) =>
    family.every((face) => face.coverage.has(codePoint));
const someFaceHas =
  (faces: StackFaces): Has =>
  (codePoint) =>
    faces.some((family) => family.some((face) => face.coverage.has(codePoint)));

function isTextCovered(text: string, has: Has): boolean {
  for (const char of text) {
    if (
      !DEFAULT_IGNORABLE.test(char) &&
      !FALLBACK_SPACE.test(char) &&
      !has(char.codePointAt(0) ?? -1)
    ) {
      return false;
    }
  }
  return true;
}

// HarfBuzz composes or decomposes a cluster when the font has the other
// canonical form, so `ẽ` (U+1EBD) draws from `e` + U+0303 and `Å` (U+212B)
// draws from U+00C5.
function isCanonicallyCovered(text: string, has: Has): boolean {
  return [text, text.normalize('NFC'), text.normalize('NFD')].some((form) =>
    isTextCovered(form, has),
  );
}

function uncoveredCodePoints(grapheme: string, has: Has): number[] {
  if (isCanonicallyCovered(grapheme, has)) {
    return [];
  }
  const codePoints = new Set<number>();
  for (const char of grapheme) {
    if (!isCanonicallyCovered(char, has)) {
      codePoints.add(char.codePointAt(0) ?? -1);
    }
  }
  return [...codePoints];
}

// One family has the whole grapheme in every face, so the face that a cell's
// style picks draws it, and Chromium never falls back to a box.
function drawsWhole(grapheme: string, faces: StackFaces): boolean {
  return faces.some((family) =>
    isCanonicallyCovered(grapheme, familyHas(family)),
  );
}

function formatCodePoint(codePoint: number): string {
  invariant(
    Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff,
    'code point must be a Unicode scalar value',
  );
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function baseOf(grapheme: string): string {
  const base = grapheme.codePointAt(0);
  invariant(base !== undefined, 'a grapheme must not be empty');
  return String.fromCodePoint(base);
}

// A combining mark on its own draws no glyph, so it is probed on its base.
export function probeText(grapheme: string, codePoint: number): string {
  const base = baseOf(grapheme);
  const char = String.fromCodePoint(codePoint);
  return COMBINING_MARK.test(char) && base !== char ? base + char : char;
}

function glyphProbeTexts(
  unbundledCodePointsByGrapheme: ReadonlyMap<string, readonly number[]>,
): string[] {
  const texts = new Set<string>();
  for (const [grapheme, codePoints] of unbundledCodePointsByGrapheme) {
    texts.add(grapheme);
    for (const codePoint of codePoints) {
      const text = probeText(grapheme, codePoint);
      texts.add(text);
      if (text !== String.fromCodePoint(codePoint)) {
        texts.add(baseOf(grapheme));
      }
    }
  }
  return [...texts];
}

export interface UsedFont {
  familyName: string;
  postScriptName: string;
  isCustomFont: boolean;
}

type FontsByText = ReadonlyMap<string, readonly UsedFont[]>;

export type ScreenGlyphFields = Pick<
  ScreenshotResult,
  'missingGlyphs' | 'missingGlyphsTruncated'
>;

// CDP names a web font by the PostScript name in its file, whatever family
// alias the profile gave it.
function faceOf(font: UsedFont, faces: StackFaces): BundledFace {
  const face = faces
    .flat()
    .find((candidate) => candidate.postScriptName === font.postScriptName);
  invariant(
    face !== undefined,
    'a web font in the page must be a bundled face of the stack',
  );
  return face;
}

// Chromium draws a cluster with one font: the first stack font that covers
// all of it, or else the first font of the stack, which then draws `.notdef`
// boxes. So the code points of a cluster that one bundled face drew are boxes
// when that face lacks them. A cluster split over several fonts is judged per
// code point.
function boxedCodePoints(
  grapheme: string,
  unbundledCodePoints: readonly number[],
  fontsByText: FontsByText,
  faces: StackFaces,
): number[] | undefined {
  const fonts = fontsByText.get(grapheme);
  if (fonts === undefined) {
    return undefined;
  }
  if (fonts.length > 0 && fonts.every((font) => !font.isCustomFont)) {
    return [];
  }
  const [font, ...otherFonts] = fonts;
  if (font === undefined) {
    return uncoveredCodePoints(grapheme, familyHas(faces[0]));
  }
  if (otherFonts.length === 0) {
    return uncoveredCodePoints(grapheme, faceHas(faceOf(font, faces)));
  }

  const boxed: number[] = [];
  for (const codePoint of unbundledCodePoints) {
    const text = probeText(grapheme, codePoint);
    let codePointFonts = fontsByText.get(text);
    if (text !== String.fromCodePoint(codePoint)) {
      const baseFonts = fontsByText.get(baseOf(grapheme));
      if (codePointFonts === undefined || baseFonts === undefined) {
        return undefined;
      }
      const markFonts = codePointFonts.filter(
        (markFont) =>
          !baseFonts.some(
            (baseFont) => baseFont.postScriptName === markFont.postScriptName,
          ),
      );
      if (markFonts.length > 0) {
        codePointFonts = markFonts;
      }
    }
    if (codePointFonts === undefined) {
      return undefined;
    }
    if (codePointFonts.every((codePointFont) => codePointFont.isCustomFont)) {
      boxed.push(codePoint);
    }
  }
  return boxed;
}

export class GlyphCheck {
  private readonly faces: StackFaces;
  private readonly cssFont: string;
  private readonly fontsByText = new Map<string, readonly UsedFont[]>();

  private constructor(faces: StackFaces, cssFont: string) {
    this.faces = faces;
    this.cssFont = cssFont;
  }

  public static forProfile(profile: RenderProfileConfig): GlyphCheck | null {
    const faces = profileFaces(profile);
    return faces === null
      ? null
      : new GlyphCheck(
          faces,
          `${String(profile.fontSize)}px ${profile.fontFamily}`,
        );
  }

  public async screen(
    page: Page,
    grid: readonly (readonly string[])[],
  ): Promise<ScreenGlyphFields> {
    const { boxedByGrapheme: boxed, allJudged } = await this.judge(
      page,
      new Set(grid.flat()),
    );
    const cellsByGrapheme = new Map<string, GlyphCell[]>();
    grid.forEach((graphemes, row) => {
      graphemes.forEach((grapheme, col) => {
        if (!boxed.has(grapheme)) {
          return;
        }
        let cells = cellsByGrapheme.get(grapheme);
        if (cells === undefined) {
          cells = [];
          cellsByGrapheme.set(grapheme, cells);
        }
        cells.push({ row, col });
      });
    });

    const cellsByCodePoint = new Map<number, GlyphCell[]>();
    let listedCells = 0;
    let truncated = !allJudged;
    for (const [grapheme, cells] of cellsByGrapheme) {
      for (const codePoint of boxed.get(grapheme) ?? []) {
        const listed = cells.slice(0, MAX_MISSING_GLYPH_CELLS - listedCells);
        if (listed.length < cells.length) {
          truncated = true;
        }
        if (listed.length === 0) {
          continue;
        }
        listedCells += listed.length;
        cellsByCodePoint.set(codePoint, [
          ...(cellsByCodePoint.get(codePoint) ?? []),
          ...listed,
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
    return {
      missingGlyphs,
      ...(truncated && { missingGlyphsTruncated: true }),
    };
  }

  public async graphemes(
    page: Page,
    graphemes: ReadonlySet<string>,
    complete: boolean,
  ): Promise<RecordedGlyphFields> {
    const judged = await this.judge(page, graphemes);
    const codePoints = new Set([...judged.boxedByGrapheme.values()].flat());
    return {
      missingGlyphs: [...codePoints]
        .sort((left, right) => left - right)
        .map((codePoint) => ({ codePoint: formatCodePoint(codePoint) })),
      ...((!complete || !judged.allJudged) && { missingGlyphsTruncated: true }),
    };
  }

  private async judge(
    page: Page,
    graphemes: Iterable<string>,
  ): Promise<{
    boxedByGrapheme: Map<string, number[]>;
    allJudged: boolean;
  }> {
    const bundled = someFaceHas(this.faces);
    const unbundledCodePointsByGrapheme = new Map<string, number[]>();
    for (const grapheme of graphemes) {
      if (grapheme !== '' && !drawsWhole(grapheme, this.faces)) {
        unbundledCodePointsByGrapheme.set(
          grapheme,
          uncoveredCodePoints(grapheme, bundled),
        );
      }
    }

    const texts = glyphProbeTexts(unbundledCodePointsByGrapheme);
    if (this.fontsByText.size + texts.length > MAX_CACHED_GLYPH_PROBES) {
      this.fontsByText.clear();
    }
    const unprobed = texts
      .filter((text) => !this.fontsByText.has(text))
      .slice(0, MAX_GLYPH_PROBES);
    if (unprobed.length > 0) {
      const probed = await probeUsedFonts(page, this.cssFont, unprobed);
      for (const [text, fonts] of probed) {
        this.fontsByText.set(text, fonts);
      }
    }

    const boxedByGrapheme = new Map<string, number[]>();
    let allJudged = true;
    for (const [
      grapheme,
      unbundledCodePoints,
    ] of unbundledCodePointsByGrapheme) {
      const codePoints = boxedCodePoints(
        grapheme,
        unbundledCodePoints,
        this.fontsByText,
        this.faces,
      );
      if (codePoints === undefined) {
        allJudged = false;
      } else if (codePoints.length > 0) {
        boxedByGrapheme.set(grapheme, codePoints);
      }
    }
    return { boxedByGrapheme, allJudged };
  }
}

export async function probeUsedFonts(
  page: Page,
  font: string,
  texts: readonly string[],
  budgetMs: number = GLYPH_PROBE_BUDGET_MS,
): Promise<Map<string, readonly UsedFont[]>> {
  invariant(texts.length > 0, 'probeUsedFonts needs at least one text');
  invariant(budgetMs > 0, 'probeUsedFonts needs a positive time budget');
  const deadline = performance.now() + budgetMs;
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

    const probed = new Map<string, readonly UsedFont[]>();
    for (
      let start = 0;
      start < nodeIds.length && performance.now() < deadline;
      start += GLYPH_PROBE_BATCH
    ) {
      const results = await Promise.all(
        nodeIds
          .slice(start, start + GLYPH_PROBE_BATCH)
          .map((nodeId) => cdp.send('CSS.getPlatformFontsForNode', { nodeId })),
      );
      results.forEach(({ fonts }, offset) => {
        const text = texts[start + offset];
        invariant(text !== undefined, 'glyph probe text must exist');
        probed.set(
          text,
          fonts.map(({ familyName, postScriptName, isCustomFont }) => ({
            familyName,
            postScriptName,
            isCustomFont,
          })),
        );
      });
    }
    return probed;
  } finally {
    await page.evaluate((rootId) => {
      const { document } = globalThis as unknown as ProbeGlobal;
      document.getElementById(rootId)?.remove();
    }, PROBE_ROOT_ID);
    await cdp.detach();
  }
}
