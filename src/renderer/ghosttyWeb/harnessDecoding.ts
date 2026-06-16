import { invariant, assertString } from '../../util/assert.js';
import { EMBEDDED_HARNESS_HTML } from './embeddedHarnessHtml.js';

export interface GhosttyHarnessVisibleLine {
  row: number;
  text: string;
}

export interface GhosttyHarnessSnapshotCell {
  char: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface GhosttyHarnessRichLine {
  lineNumber: number;
  cells: GhosttyHarnessSnapshotCell[];
}

export interface GhosttyHarnessSnapshot {
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  isAltScreen: boolean;
  visibleLines: GhosttyHarnessVisibleLine[];
  scrollbackLines?: GhosttyHarnessVisibleLine[];
  cells?: GhosttyHarnessRichLine[];
}

/**
 * One decoded terminal column: the cell's full grapheme cluster plus its
 * column span. `width === 0` marks a wide glyph's trailing spacer column.
 */
export interface GhosttyDecodedColumn {
  grapheme: string;
  width: number;
}

/**
 * Strip ONLY trailing ASCII spaces (0x20). Unlike String.prototype.trimEnd
 * this preserves other trailing whitespace (tabs, NBSP, etc.), keeping the
 * canonical visible text aligned with the libghostty-vt backend.
 *
 * Exported as the host-testable twin of the identical function embedded in
 * EMBEDDED_HARNESS_HTML; the harness copy is the browser runtime and cannot
 * import this module, so the two must stay byte-for-byte in sync.
 */
export function stripTrailingAsciiSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) {
    end -= 1;
  }
  return end === text.length ? text : text.slice(0, end);
}

/**
 * Assemble one canonical visible line from a per-column reader, then
 * right-trim trailing ASCII spaces. A width-0 column (a wide glyph's trailing
 * spacer) contributes nothing, so a row of `A`+wide(`漢`)+wide(`字`)+`B`
 * yields `A漢字B` — matching the libghostty-vt backend's visibleLines[].text.
 * A genuine blank interior cell decodes to a single ' ', so interior gaps
 * survive and trailing gaps trim away. Non-empty cells contribute their FULL
 * grapheme cluster, so continuation codepoints (emoji ZWJ, NFD combining
 * marks) are preserved instead of being truncated to the base codepoint.
 *
 * The live ghostty-web engine returns the NUL codepoint (U+0000) for a blank
 * cell: getGrapheme yields `[0]`, so getGraphemeString runs
 * `String.fromCodePoint(0)` and produces a NUL, not ' ' (its empty-array
 * ' ' fallback never fires). Left as-is those NULs would survive
 * stripTrailingAsciiSpaces (which strips only 0x20) and diverge from the
 * native backend's right-trimmed ' '-blank form, so a kept cell whose grapheme
 * is a lone NUL is normalized to ' ' here.
 *
 * Exported as the host-testable twin of the decodeGraphemeLine function
 * embedded in EMBEDDED_HARNESS_HTML; keep the two in sync.
 */
export function assembleCanonicalLine(
  cols: number,
  readColumn: (col: number) => GhosttyDecodedColumn,
): string {
  assertNonNegativeInteger(
    cols,
    'canonical line cols must be a non-negative integer',
  );
  let text = '';
  for (let col = 0; col < cols; col += 1) {
    const column = readColumn(col);
    assertString(column.grapheme, 'decoded grapheme must be a string');
    assertNonNegativeInteger(
      column.width,
      'decoded cell width must be a non-negative integer',
    );
    if (column.width === 0) {
      continue;
    }
    text += column.grapheme === '\u0000' ? ' ' : column.grapheme;
  }
  return stripTrailingAsciiSpaces(text);
}

export function assertNonNegativeInteger(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value >= 0,
    message,
  );
}

export function assertPositiveInteger(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value > 0,
    message,
  );
}

export function assertPositiveNumber(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isFinite(value) && value > 0,
    message,
  );
}

export function assertHexColor(
  value: unknown,
  message: string,
): asserts value is string {
  assertString(value, message);
  invariant(/^#[0-9a-fA-F]{6}$/u.test(value), message);
}

export function normalizeError(error: unknown, prefix: string): Error {
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`, { cause: error });
  }

  return new Error(`${prefix}: ${String(error)}`);
}

export function loadHarnessHtml(): string {
  // The embedded harness is the canonical runtime copy. Serving it directly keeps
  // snapshot extraction behavior in sync with the bridge implementation even when
  // the standalone source template drifts.
  return EMBEDDED_HARNESS_HTML;
}

function validateHarnessLines(
  lines: unknown,
  label: string,
  rowUpperBoundExclusive?: number,
): GhosttyHarnessVisibleLine[] {
  invariant(Array.isArray(lines), `${label}s must be an array`);

  const validatedLines: GhosttyHarnessVisibleLine[] = [];
  let previousRow = -1;
  for (const [index, lineValue] of lines.entries()) {
    const lineIndex = String(index);
    invariant(
      lineValue !== null && typeof lineValue === 'object',
      `${label} ${lineIndex} must be an object`,
    );

    const lineCandidate = lineValue as {
      row?: unknown;
      text?: unknown;
    };
    assertNonNegativeInteger(
      lineCandidate.row,
      `${label} ${lineIndex} row must be a non-negative integer`,
    );
    assertString(
      lineCandidate.text,
      `${label} ${lineIndex} text must be a string`,
    );
    if (rowUpperBoundExclusive !== undefined) {
      invariant(
        lineCandidate.row < rowUpperBoundExclusive,
        `${label} ${lineIndex} row must be within bounds`,
      );
    }
    invariant(
      lineCandidate.row > previousRow,
      `${label} ${lineIndex} rows must be strictly increasing`,
    );
    previousRow = lineCandidate.row;
    validatedLines.push({
      row: lineCandidate.row,
      text: lineCandidate.text,
    });
  }

  return validatedLines;
}

function validateHarnessSnapshotCells(
  cells: unknown,
  visibleLines: readonly GhosttyHarnessVisibleLine[],
  cols: number,
): GhosttyHarnessRichLine[] {
  invariant(Array.isArray(cells), 'snapshot cells must be an array');

  const validatedRichLines: GhosttyHarnessRichLine[] = [];
  for (const [lineIndex, lineValue] of cells.entries()) {
    invariant(
      lineValue !== null && typeof lineValue === 'object',
      `snapshot cell line ${String(lineIndex)} must be an object`,
    );

    const lineCandidate = lineValue as {
      lineNumber?: unknown;
      cells?: unknown;
    };
    assertNonNegativeInteger(
      lineCandidate.lineNumber,
      `snapshot cell line ${String(lineIndex)} lineNumber must be a non-negative integer`,
    );
    invariant(
      Array.isArray(lineCandidate.cells),
      `snapshot cell line ${String(lineIndex)} cells must be an array`,
    );
    invariant(
      lineIndex < visibleLines.length,
      `snapshot cell line ${String(lineIndex)} must map to a visible line`,
    );
    invariant(
      lineCandidate.lineNumber === visibleLines[lineIndex]?.row,
      `snapshot cell line ${String(lineIndex)} lineNumber must match visible line row`,
    );

    const validatedCells: GhosttyHarnessSnapshotCell[] = [];
    for (const [cellIndex, cellValue] of lineCandidate.cells.entries()) {
      invariant(
        cellValue !== null && typeof cellValue === 'object',
        `snapshot cell ${String(lineIndex)}:${String(cellIndex)} must be an object`,
      );

      const cellCandidate = cellValue as {
        char?: unknown;
        fg?: unknown;
        bg?: unknown;
        bold?: unknown;
        italic?: unknown;
        underline?: unknown;
        strikethrough?: unknown;
      };
      assertString(
        cellCandidate.char,
        `snapshot cell ${String(lineIndex)}:${String(cellIndex)} char must be a string`,
      );
      if (cellCandidate.fg !== undefined) {
        assertHexColor(
          cellCandidate.fg,
          `snapshot cell ${String(lineIndex)}:${String(cellIndex)} fg must be a hex color`,
        );
      }
      if (cellCandidate.bg !== undefined) {
        assertHexColor(
          cellCandidate.bg,
          `snapshot cell ${String(lineIndex)}:${String(cellIndex)} bg must be a hex color`,
        );
      }
      for (const [fieldName, fieldValue] of Object.entries({
        bold: cellCandidate.bold,
        italic: cellCandidate.italic,
        underline: cellCandidate.underline,
        strikethrough: cellCandidate.strikethrough,
      })) {
        invariant(
          fieldValue === undefined || typeof fieldValue === 'boolean',
          `snapshot cell ${String(lineIndex)}:${String(cellIndex)} ${fieldName} must be a boolean when provided`,
        );
      }

      const validatedCell: GhosttyHarnessSnapshotCell = {
        char: cellCandidate.char,
      };
      if (cellCandidate.fg !== undefined) {
        validatedCell.fg = cellCandidate.fg;
      }
      if (cellCandidate.bg !== undefined) {
        validatedCell.bg = cellCandidate.bg;
      }
      if (typeof cellCandidate.bold === 'boolean') {
        validatedCell.bold = cellCandidate.bold;
      }
      if (typeof cellCandidate.italic === 'boolean') {
        validatedCell.italic = cellCandidate.italic;
      }
      if (typeof cellCandidate.underline === 'boolean') {
        validatedCell.underline = cellCandidate.underline;
      }
      if (typeof cellCandidate.strikethrough === 'boolean') {
        validatedCell.strikethrough = cellCandidate.strikethrough;
      }
      validatedCells.push(validatedCell);
    }

    invariant(
      validatedCells.length <= cols,
      `snapshot cell line ${String(lineIndex)} cell count must not exceed the terminal width`,
    );
    validatedRichLines.push({
      lineNumber: lineCandidate.lineNumber,
      cells: validatedCells,
    });
  }

  invariant(
    validatedRichLines.length === visibleLines.length,
    'snapshot cell line count must match visible line count',
  );
  return validatedRichLines;
}

export function validateHarnessSnapshot(
  snapshot: unknown,
): GhosttyHarnessSnapshot {
  invariant(
    snapshot !== null && typeof snapshot === 'object',
    'ghostty-web snapshot must be an object',
  );

  const candidate = snapshot as {
    cols?: unknown;
    rows?: unknown;
    cursorRow?: unknown;
    cursorCol?: unknown;
    isAltScreen?: unknown;
    visibleLines?: unknown;
    scrollbackLines?: unknown;
    cells?: unknown;
  };

  assertPositiveInteger(
    candidate.cols,
    'snapshot cols must be a positive integer',
  );
  assertPositiveInteger(
    candidate.rows,
    'snapshot rows must be a positive integer',
  );
  assertNonNegativeInteger(
    candidate.cursorRow,
    'snapshot cursorRow must be a non-negative integer',
  );
  assertNonNegativeInteger(
    candidate.cursorCol,
    'snapshot cursorCol must be a non-negative integer',
  );
  invariant(
    candidate.cursorRow < candidate.rows,
    'snapshot cursorRow must be within the terminal height',
  );
  invariant(
    candidate.cursorCol < candidate.cols,
    'snapshot cursorCol must be within the terminal width',
  );
  invariant(
    typeof candidate.isAltScreen === 'boolean',
    'snapshot isAltScreen must be a boolean',
  );

  const visibleLines = validateHarnessLines(
    candidate.visibleLines,
    'snapshot visible line',
    candidate.rows,
  );
  invariant(
    visibleLines.length <= candidate.rows,
    'snapshot visibleLines length must not exceed the viewport height',
  );

  const scrollbackLines =
    candidate.scrollbackLines === undefined
      ? undefined
      : validateHarnessLines(
          candidate.scrollbackLines,
          'snapshot scrollback line',
        );
  const cells =
    candidate.cells === undefined
      ? undefined
      : validateHarnessSnapshotCells(
          candidate.cells,
          visibleLines,
          candidate.cols,
        );

  return {
    cols: candidate.cols,
    rows: candidate.rows,
    cursorRow: candidate.cursorRow,
    cursorCol: candidate.cursorCol,
    isAltScreen: candidate.isAltScreen,
    visibleLines,
    ...(scrollbackLines !== undefined && { scrollbackLines }),
    ...(cells !== undefined && { cells }),
  };
}
