import type { SnapshotCell } from '../protocol/schemas.js';
import type { RenderProfileConfig } from '../renderer/types.js';
import {
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
  type BundledFontAsset,
} from '../renderer/bundledFont.js';
import { invariant } from '../util/assert.js';

/**
 * Fixed reference cell metrics for SVG export. The builtin render profiles pin
 * fontSize 14; the cell box is 8.4x18 px (a 0.6 advance-width ratio and a
 * ~1.29 line height, matching common monospace metrics). Text runs are pinned
 * to the grid with `textLength`, so viewers with different fonts still align
 * glyphs to these columns. Constants (not measured fonts) keep the output
 * deterministic.
 */
export const SVG_FONT_SIZE = 14;
export const SVG_CELL_WIDTH = 8.4;
export const SVG_CELL_HEIGHT = 18;
/** Text baseline offset from the top of a cell row. */
export const SVG_BASELINE_OFFSET = 14;
/** Block cursor is drawn as a translucent overlay so the glyph stays legible. */
export const SVG_CURSOR_FILL_OPACITY = 0.35;

export interface SvgGridFrame {
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  /**
   * Whether the cursor block should be drawn (DECTCEM). Defaults to visible.
   * The libghostty-vt native snapshot does not currently expose cursor
   * visibility, so captured frames leave this unset; the renderer honors it
   * when a producer can supply it.
   */
  cursorVisible?: boolean;
  /**
   * Dense visible grid: `lines[row]` lists cells by column. Rows and trailing
   * columns without content may be shorter than `rows`/`cols`.
   */
  lines: ReadonlyArray<ReadonlyArray<SnapshotCell>>;
  /** How long this frame stays visible on the animated timeline. */
  holdMs: number;
}

export interface SvgRenderOptions {
  profile: RenderProfileConfig;
  frames: readonly SvgGridFrame[];
  animate: boolean;
}

type GlyphFace = 'latin' | 'symbols' | 'system';

interface StyleRun {
  startCol: number;
  cellCount: number;
  text: string;
  fg: string | undefined;
  bg: string | undefined;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  face: GlyphFace;
}

/**
 * Both bundled fonts are licensed under the SIL Open Font License 1.1 (see
 * src/renderer/ghosttyWeb/assets/FONT-LICENSE.txt); embedded SVGs carry this
 * attribution as an XML comment.
 */
const FONT_LICENSE_COMMENT =
  '<!-- Embedded fonts (SIL Open Font License 1.1): JetBrains Mono by JetBrains s.r.o. (https://github.com/JetBrains/JetBrainsMono); Symbols Nerd Font Mono by the Nerd Fonts contributors (https://github.com/ryanoasis/nerd-fonts), embedded only when glyphs covered by the symbols face are present. -->';

/**
 * Exact cmap coverage of the pinned JetBrainsMono-Regular-latin.woff2 asset
 * (dumped offline from the checked-in file's format-4 cmap: 229 code points).
 * The asset is hash-pinned via bundledFont.ts, so these ranges are stable.
 *
 * Explicit boundary: glyphs outside BOTH bundled faces — notably CJK and
 * most emoji — render via the viewer's monospace fallback. This is kept
 * deliberately: the pinned render profiles bundle no CJK face (a suitable
 * one is tens of MB), and converting glyphs to paths would require a
 * font-shaping dependency. The reference ghostty-web PNG/WebM path has the
 * same boundary (same two faces, then Chromium/system-font fallback). Layout
 * stays deterministic regardless: text runs are pinned to the terminal grid
 * via textLength, so fallback glyph shapes vary but columns never shift.
 */
const PRIMARY_LATIN_SUBSET_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0d, 0x0d],
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x102, 0x102],
  [0x131, 0x131],
  [0x152, 0x153],
  [0x2bc, 0x2bc],
  [0x2c6, 0x2c6],
  [0x2da, 0x2da],
  [0x2dc, 0x2dc],
  [0x300, 0x301],
  [0x303, 0x304],
  [0x308, 0x309],
  [0x323, 0x323],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2022, 0x2022],
  [0x2026, 0x2026],
  [0x2032, 0x2033],
  [0x2039, 0x203a],
  [0x2044, 0x2044],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
];

function isCoveredByPrimaryLatinSubset(codePoint: number): boolean {
  for (const [start, end] of PRIMARY_LATIN_SUBSET_RANGES) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
}

/**
 * Exact cmap coverage of the pinned SymbolsNerdFontMono-Regular.ttf asset
 * (dumped offline from the checked-in file's format-12 cmap: 10,410 code
 * points in 28 contiguous ranges). The asset is hash-pinned via
 * bundledFont.ts, so these ranges are stable. To regenerate: parse the TTF
 * table directory for the `cmap` table, pick the format-12 subtable, and
 * collapse its sequential map groups into [start, end] pairs.
 */
const SYMBOLS_FACE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x23fb, 0x23fe],
  [0x2630, 0x2630],
  [0x2665, 0x2665],
  [0x26a1, 0x26a1],
  [0x276c, 0x2771],
  [0x2b58, 0x2b58],
  [0xe000, 0xe00a],
  [0xe0a0, 0xe0a3],
  [0xe0b0, 0xe0c8],
  [0xe0ca, 0xe0ca],
  [0xe0cc, 0xe0d2],
  [0xe0d4, 0xe0d4],
  [0xe0d6, 0xe0d7],
  [0xe200, 0xe2a9],
  [0xe300, 0xe3e3],
  [0xe5fa, 0xe6b8],
  [0xe700, 0xe8ef],
  [0xea60, 0xea88],
  [0xea8a, 0xea8c],
  [0xea8f, 0xeac7],
  [0xeac9, 0xeac9],
  [0xeacc, 0xeb09],
  [0xeb0b, 0xeb4e],
  [0xeb50, 0xec1e],
  [0xed00, 0xefce],
  [0xf000, 0xf381],
  [0xf400, 0xf533],
  [0xf0001, 0xf1af0],
];

function isCoveredBySymbolsFace(codePoint: number): boolean {
  for (const [start, end] of SYMBOLS_FACE_RANGES) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
}

/**
 * Classify which face actually renders a glyph: the primary latin subset,
 * the embedded symbols face, or the viewer's system monospace fallback
 * (glyphs covered by neither bundled face, e.g. CJK and most emoji). The
 * three resolve to different real fonts with different natural advances, so
 * run grouping must not mix them. A cluster containing any system-fallback
 * code point classifies as 'system' since the fallback font shapes it.
 */
function classifyGlyphFace(char: string): GlyphFace {
  let sawSymbolsGlyph = false;
  for (const character of char) {
    const codePoint = character.codePointAt(0);
    invariant(codePoint !== undefined, 'iterated character must exist');
    if (isCoveredByPrimaryLatinSubset(codePoint)) {
      continue;
    }
    if (isCoveredBySymbolsFace(codePoint)) {
      sawSymbolsGlyph = true;
      continue;
    }
    return 'system';
  }
  return sawSymbolsGlyph ? 'symbols' : 'latin';
}

/**
 * The symbols face is embedded only when a rendered glyph actually resolves
 * to it; 'system' glyphs (covered by neither bundled face) gain nothing from
 * embedding, so they no longer trigger the 2.5 MB payload.
 */
function framesContainSymbolsGlyph(frames: readonly SvgGridFrame[]): boolean {
  for (const frame of frames) {
    for (const cells of frame.lines) {
      for (const cell of cells) {
        if (classifyGlyphFace(cell.char) === 'symbols') {
          return true;
        }
      }
    }
  }
  return false;
}

function renderFontFace(asset: BundledFontAsset, format: string): string {
  invariant(asset.buffer.byteLength > 0, 'bundled font asset must have bytes');
  const dataUri = `data:${asset.contentType};base64,${asset.buffer.toString('base64')}`;
  return `@font-face{font-family:"${asset.family}";src:url(${dataUri}) format("${format}");font-weight:${asset.weight};font-style:${asset.style};}`;
}

/**
 * Standalone SVGs must carry their fonts so glyphs render identically without
 * locally installed fonts. The 21 KB JetBrains Mono latin subset is always
 * embedded; the 2.5 MB Symbols Nerd Font is embedded only when a rendered
 * frame contains a glyph the symbols face actually covers, keeping ordinary
 * exports small. Both are base64 of checked-in asset bytes, so output stays
 * deterministic.
 */
function renderFontStyleElement(frames: readonly SvgGridFrame[]): string {
  const fontFaces = [renderFontFace(BUNDLED_PRIMARY_FONT_ASSET, 'woff2')];
  if (framesContainSymbolsGlyph(frames)) {
    fontFaces.push(renderFontFace(BUNDLED_SYMBOLS_FONT_ASSET, 'truetype'));
  }
  return `<style>${fontFaces.join('\n')}</style>`;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

// XML 1.0 forbids raw C0 control characters (except tab/newline/CR, which
// never appear inside a terminal grid cell) and DEL; strip them defensively.
function stripXmlDisallowed(value: string): string {
  let stripped = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    invariant(codePoint !== undefined, 'iterated character must exist');
    if (codePoint < 0x20 || codePoint === 0x7f) {
      continue;
    }
    stripped += character;
  }
  return stripped;
}

function escapeXml(value: string): string {
  return stripXmlDisallowed(
    value.replace(/[&<>"']/gu, (match) => {
      const escaped = XML_ESCAPES[match];
      invariant(escaped !== undefined, 'xml escape table must cover match');
      return escaped;
    }),
  );
}

function formatSvgNumber(value: number): string {
  invariant(Number.isFinite(value), 'svg number must be finite');
  const fixed = value.toFixed(2);
  const trimmed = fixed.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/**
 * Serialize a keyTime with enough precision that a 1 ms hold stays distinct:
 * 12 decimals resolve millisecond boundaries for timelines up to 10^12 ms
 * (~31 years), far beyond any recordable session. Trailing zeros are trimmed
 * so output stays canonical and deterministic.
 */
function formatKeyTime(offsetMs: number, totalMs: number): string {
  invariant(totalMs > 0, 'animation total duration must be positive');
  invariant(
    offsetMs >= 0 && offsetMs <= totalMs,
    'animation key time offset must lie within the total duration',
  );
  const fixed = (offsetMs / totalMs).toFixed(12);
  const trimmed = fixed.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed.length > 0 ? trimmed : '0';
}

function styleMatches(run: StyleRun, cell: SnapshotCell): boolean {
  return (
    run.fg === cell.fg &&
    run.bg === cell.bg &&
    run.bold === (cell.bold ?? false) &&
    run.italic === (cell.italic ?? false) &&
    run.underline === (cell.underline ?? false)
  );
}

/**
 * Group one row's cells into consecutive same-style TEXT runs of HOMOGENEOUS
 * cell width. Width-1 glyphs with matching style merge. A wide glyph (leading
 * cell's `width` >= 2) always forms its own single-glyph run whose cell count
 * spans its trailing spacer cells (`char: ''`), regardless of the spacers'
 * styling. Mixed-width runs are deliberately split: `textLength` scaling with
 * `lengthAdjust="spacingAndGlyphs"` distributes advances uniformly, so a
 * fallback font whose wide-glyph advance ratio differs would shift interior
 * glyphs off their columns — within a homogeneous-width run a monospace
 * fallback has equal natural advances and every glyph lands exactly on its
 * column. Runs also split at FONT-FACE boundaries (latin subset vs the
 * symbols/fallback path, see classifyGlyphFace): the two faces have
 * different natural advances, so a mixed-face run would drift interior
 * glyphs exactly like a mixed-width one. Every OTHER empty cell — zero-style
 * gap padding for untouched columns (e.g. ESC[NC) and styled empties such as
 * colored field padding — breaks the current run so the next glyph
 * re-anchors at its true column: merging an empty cell would stretch the
 * run's glyphs across its column. Backgrounds are grouped independently (see
 * groupRowIntoBackgroundRuns), so a styled empty cell still shades its
 * column.
 */
export function groupRowIntoStyleRuns(
  cells: readonly SnapshotCell[],
): StyleRun[] {
  const runs: StyleRun[] = [];
  let current: StyleRun | null = null;
  let pendingSpacers = 0;

  for (const [col, cell] of cells.entries()) {
    if (pendingSpacers > 0) {
      // Column covered by the preceding wide glyph: extend that glyph's run
      // whatever the spacer's styling looks like.
      pendingSpacers -= 1;
      invariant(
        cell.char === '',
        'wide-glyph trailing cell must be an empty spacer',
      );
      invariant(current !== null, 'wide glyph run must exist for its spacers');
      current.cellCount += 1;
      if (pendingSpacers === 0) {
        // The wide glyph's single-glyph run is complete; the next glyph must
        // start its own run.
        current = null;
      }
      continue;
    }
    if (cell.char === '') {
      current = null;
      continue;
    }
    const width = cell.width ?? 1;
    invariant(
      Number.isInteger(width) && width >= 1,
      'snapshot cell width must be a positive integer when provided',
    );
    const face = classifyGlyphFace(cell.char);
    if (
      width === 1 &&
      current !== null &&
      current.face === face &&
      styleMatches(current, cell)
    ) {
      current.cellCount += 1;
      current.text += cell.char;
    } else {
      current = {
        startCol: col,
        cellCount: 1,
        text: cell.char,
        fg: cell.fg,
        bg: cell.bg,
        bold: cell.bold ?? false,
        italic: cell.italic ?? false,
        underline: cell.underline ?? false,
        face,
      };
      runs.push(current);
    }
    pendingSpacers = width - 1;
  }

  let previousEndCol = 0;
  for (const run of runs) {
    invariant(
      run.startCol >= previousEndCol,
      'style runs must cover strictly advancing, non-overlapping columns',
    );
    previousEndCol = run.startCol + run.cellCount;
  }
  invariant(
    previousEndCol <= cells.length,
    'style runs must not extend past the row cells',
  );

  return runs;
}

interface BackgroundRun {
  startCol: number;
  cellCount: number;
  bg: string;
}

/**
 * Group one row's cells into consecutive same-background runs, independent of
 * text-run grouping: styled empty cells (colored field padding, wide-glyph
 * spacers) shade their columns even though they never join a text run, and
 * adjacent cells sharing a background merge into one rect regardless of any
 * other styling differences.
 */
export function groupRowIntoBackgroundRuns(
  cells: readonly SnapshotCell[],
): BackgroundRun[] {
  const runs: BackgroundRun[] = [];
  let current: BackgroundRun | null = null;

  for (const [col, cell] of cells.entries()) {
    if (cell.bg === undefined) {
      current = null;
      continue;
    }
    if (current !== null && current.bg === cell.bg) {
      current.cellCount += 1;
      continue;
    }
    current = { startCol: col, cellCount: 1, bg: cell.bg };
    runs.push(current);
  }

  return runs;
}

function renderRunBackground(run: BackgroundRun, row: number): string {
  const x = formatSvgNumber(run.startCol * SVG_CELL_WIDTH);
  const y = formatSvgNumber(row * SVG_CELL_HEIGHT);
  const width = formatSvgNumber(run.cellCount * SVG_CELL_WIDTH);
  const height = formatSvgNumber(SVG_CELL_HEIGHT);
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeXml(run.bg)}"/>`;
}

function renderRunText(run: StyleRun, row: number): string | null {
  const hasVisibleGlyphs = run.text.trim().length > 0;
  const hasUnderlinedSpan = run.underline && run.text.length > 0;
  if (!hasVisibleGlyphs && !hasUnderlinedSpan) {
    return null;
  }

  const attributes = [
    `x="${formatSvgNumber(run.startCol * SVG_CELL_WIDTH)}"`,
    `y="${formatSvgNumber(row * SVG_CELL_HEIGHT + SVG_BASELINE_OFFSET)}"`,
    `textLength="${formatSvgNumber(run.cellCount * SVG_CELL_WIDTH)}"`,
    'lengthAdjust="spacingAndGlyphs"',
    'xml:space="preserve"',
  ];
  if (run.fg !== undefined) {
    attributes.push(`fill="${escapeXml(run.fg)}"`);
  }
  if (run.bold) {
    attributes.push('font-weight="bold"');
  }
  if (run.italic) {
    attributes.push('font-style="italic"');
  }
  if (run.underline) {
    attributes.push('text-decoration="underline"');
  }

  return `<text ${attributes.join(' ')}>${escapeXml(run.text)}</text>`;
}

function renderCursor(
  frame: SvgGridFrame,
  profile: RenderProfileConfig,
): string {
  invariant(
    frame.cursorRow >= 0 && frame.cursorRow < frame.rows,
    'frame cursorRow must be within rows',
  );
  invariant(
    frame.cursorCol >= 0 && frame.cursorCol < frame.cols,
    'frame cursorCol must be within cols',
  );
  const x = formatSvgNumber(frame.cursorCol * SVG_CELL_WIDTH);
  const y = formatSvgNumber(frame.cursorRow * SVG_CELL_HEIGHT);
  const width = formatSvgNumber(SVG_CELL_WIDTH);
  const height = formatSvgNumber(SVG_CELL_HEIGHT);
  const opacity = formatSvgNumber(SVG_CURSOR_FILL_OPACITY);
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeXml(profile.foregroundColor)}" fill-opacity="${opacity}"/>`;
}

function renderFrameElements(
  frame: SvgGridFrame,
  profile: RenderProfileConfig,
): string[] {
  invariant(frame.cols > 0, 'frame cols must be positive');
  invariant(frame.rows > 0, 'frame rows must be positive');
  invariant(
    frame.lines.length <= frame.rows,
    'frame lines must fit within frame rows',
  );

  const backgrounds: string[] = [];
  const texts: string[] = [];
  for (const [row, cells] of frame.lines.entries()) {
    invariant(
      cells.length <= frame.cols,
      'frame row cells must fit within frame cols',
    );
    for (const backgroundRun of groupRowIntoBackgroundRuns(cells)) {
      backgrounds.push(renderRunBackground(backgroundRun, row));
    }
    for (const run of groupRowIntoStyleRuns(cells)) {
      const text = renderRunText(run, row);
      if (text !== null) {
        texts.push(text);
      }
    }
  }

  // Honor DECTCEM when the frame producer supplies visibility; unset means
  // visible (the native snapshot does not expose cursor visibility yet).
  const cursor =
    frame.cursorVisible === false ? [] : [renderCursor(frame, profile)];
  return [...backgrounds, ...texts, ...cursor];
}

function renderVisibilityAnimation(
  frameIndex: number,
  frameCount: number,
  startMs: number,
  endMs: number,
  totalMs: number,
): string {
  invariant(
    frameIndex >= 0 && frameIndex < frameCount,
    'frame index must be within the frame count',
  );
  invariant(startMs < endMs, 'frame window must be non-empty');

  // A positive hold must survive serialization: rounded keyTimes that
  // collapse to the same value would give the frame a zero-length interval
  // and silently drop a recorded transition.
  const startKeyTime = formatKeyTime(startMs, totalMs);
  const endKeyTime = formatKeyTime(endMs, totalMs);
  invariant(
    Number(startKeyTime) < Number(endKeyTime),
    'serialized frame keyTimes must be strictly increasing for positive holds',
  );

  let values: string;
  let keyTimes: string;
  if (frameIndex === 0) {
    values = 'visible;hidden';
    invariant(
      Number(endKeyTime) > 0,
      'first frame end keyTime must be positive',
    );
    keyTimes = `0;${endKeyTime}`;
  } else if (frameIndex === frameCount - 1) {
    values = 'hidden;visible';
    invariant(
      Number(startKeyTime) > 0,
      'last frame start keyTime must be positive',
    );
    keyTimes = `0;${startKeyTime}`;
  } else {
    values = 'hidden;visible;hidden';
    invariant(
      Number(startKeyTime) > 0,
      'interior frame start keyTime must be positive',
    );
    keyTimes = `0;${startKeyTime};${endKeyTime}`;
  }

  return `<animate attributeName="visibility" values="${values}" keyTimes="${keyTimes}" dur="${formatSvgNumber(totalMs)}ms" calcMode="discrete" repeatCount="indefinite"/>`;
}

/**
 * Render de-duplicated grid frames as deterministic SVG text. Still exports
 * (`animate: false`) render only the final frame; animated exports emit one
 * `<g>` per frame toggled by SMIL discrete visibility animations whose key
 * times derive purely from the frames' recorded `holdMs` values. The output
 * contains no wall-clock timestamps, random identifiers, or other
 * environment-dependent content, so repeated exports of the same session are
 * byte-identical.
 */
export function renderGridFramesToSvg(options: SvgRenderOptions): string {
  const { profile, frames, animate } = options;
  invariant(frames.length > 0, 'svg rendering requires at least one frame');
  invariant(
    profile.fontSize === SVG_FONT_SIZE,
    'svg cell metrics are pinned to the reference profile font size',
  );
  for (const frame of frames) {
    invariant(
      Number.isInteger(frame.holdMs) && frame.holdMs >= 0,
      'frame holdMs must be a non-negative integer',
    );
  }

  // Loop instead of Math.max(...spread): argument-spreading a large frame
  // array (long recordings) exceeds V8's argument limit and throws.
  let canvasCols = 0;
  let canvasRows = 0;
  for (const frame of frames) {
    canvasCols = Math.max(canvasCols, frame.cols);
    canvasRows = Math.max(canvasRows, frame.rows);
  }
  invariant(
    canvasCols > 0 && canvasRows > 0,
    'svg canvas dimensions must be positive',
  );
  const width = formatSvgNumber(canvasCols * SVG_CELL_WIDTH);
  const height = formatSvgNumber(canvasRows * SVG_CELL_HEIGHT);

  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escapeXml(profile.fontFamily)}" font-size="${formatSvgNumber(profile.fontSize)}" fill="${escapeXml(profile.foregroundColor)}">`,
    FONT_LICENSE_COMMENT,
    renderFontStyleElement(frames),
    `<rect width="100%" height="100%" fill="${escapeXml(profile.backgroundColor)}"/>`,
  ];

  // Element lists are appended one-by-one rather than push(...spread): a
  // dense frame can produce enough elements to exceed V8's argument limit.
  if (!animate || frames.length === 1) {
    const finalFrame = frames.at(-1);
    invariant(finalFrame !== undefined, 'final frame must exist');
    for (const element of renderFrameElements(finalFrame, profile)) {
      lines.push(element);
    }
  } else {
    const totalMs = frames.reduce((sum, frame) => sum + frame.holdMs, 0);
    invariant(totalMs > 0, 'animated svg requires a positive total duration');

    let offsetMs = 0;
    for (const [frameIndex, frame] of frames.entries()) {
      invariant(frame.holdMs > 0, 'animated svg frames must hold for >0 ms');
      const endMs = offsetMs + frame.holdMs;
      lines.push(
        '<g visibility="hidden">',
        renderVisibilityAnimation(
          frameIndex,
          frames.length,
          offsetMs,
          endMs,
          totalMs,
        ),
      );
      for (const element of renderFrameElements(frame, profile)) {
        lines.push(element);
      }
      lines.push('</g>');
      offsetMs = endMs;
    }
  }

  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}
