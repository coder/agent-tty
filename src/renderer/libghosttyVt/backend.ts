import { isAbsolute } from 'node:path';

import type {
  CreateTerminalOptions,
  GhosttyVtTerminal,
  NativeInfo,
  SnapshotCell as NativeSnapshotCell,
  TerminalSnapshot,
  VisibleLine as NativeVisibleLine,
} from '@coder/libghostty-vt-node';

import type {
  RendererBackend,
  ScreenshotOptions,
  SnapshotOptions,
} from '../backend.js';
import type { SnapshotCell } from '../../protocol/schemas.js';
import { GhosttyWebBackend } from '../ghosttyWeb/backend.js';
import type {
  RenderProfileConfig,
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from '../types.js';
import { SemanticSnapshotSchema } from '../types.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../../config/defaults.js';
import { invariant, assertString, unreachable } from '../../util/assert.js';
import { Logger, createProcessLogger } from '../../util/logger.js';

export interface LibghosttyVtNativeModule {
  createTerminal(options: CreateTerminalOptions): GhosttyVtTerminal;
  getNativeInfo?: () => NativeInfo;
}

const DEFAULT_SCROLLBACK_LIMIT = 10_000;

export interface LibghosttyVtBackendOptions {
  initialCols?: number;
  initialRows?: number;
  scrollbackLimit?: number;
  loadNative?: () => Promise<LibghosttyVtNativeModule>;
  fallbackFactory?: (
    sessionId: string,
    profile: RenderProfileConfig,
    options?: unknown,
  ) => RendererBackend;
  logger?: Logger;
}

type NativeSnapshotBooleanKey = 'bold' | 'italic' | 'underline';
type NativeSnapshotStringKey = 'foreground' | 'background';

function assertPositiveInteger(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value > 0,
    message,
  );
}

function assertNonNegativeInteger(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value >= 0,
    message,
  );
}

function cloneReplayInput(input: ReplayInput): ReplayInput {
  return {
    sessionId: input.sessionId,
    initialCols: input.initialCols,
    initialRows: input.initialRows,
    targetSeq: input.targetSeq,
    events: input.events.map((event) => ({
      ...event,
      payload: { ...event.payload },
    })) as ReplayInput['events'],
  };
}

function validateNativeVisibleLines(
  lines: unknown,
  label: string,
): NativeVisibleLine[] {
  invariant(Array.isArray(lines), `${label} must be an array`);

  let previousRow = -1;
  return lines.map((line, index) => {
    invariant(
      line !== null && typeof line === 'object',
      `${label}[${String(index)}] must be an object`,
    );
    const candidate = line as { row?: unknown; text?: unknown };
    assertNonNegativeInteger(
      candidate.row,
      `${label}[${String(index)}].row must be a non-negative integer`,
    );
    assertString(
      candidate.text,
      `${label}[${String(index)}].text must be a string`,
    );
    invariant(
      candidate.row > previousRow,
      `${label} rows must be strictly increasing`,
    );
    previousRow = candidate.row;

    return { row: candidate.row, text: candidate.text };
  });
}

/**
 * Pad the native visible lines to exactly `rows` entries by appending blank
 * trailing lines (`text: ''`). The native ReadLine path already right-trims
 * trailing ASCII spaces, expands full grapheme clusters, and renders blank
 * cells as ' ' (terminal.cc), but it omits trailing blank rows, so only the
 * line count needs aligning with the canonical pad-to-rows form. Each visible
 * line's `row` is its index (native emits contiguous 0-based rows), so the
 * appended lines continue that sequence. This converges the libghostty-vt
 * backend's `visibleLines[].text` with the ghostty-web backend so the two
 * agree on the Screen Hash. See docs/prd/screen-hash/PRD.md.
 */
function padVisibleLinesToRows(
  lines: readonly NativeVisibleLine[],
  rows: number,
): NativeVisibleLine[] {
  invariant(
    lines.length <= rows,
    'native visible line count must not exceed terminal rows',
  );
  const padded: NativeVisibleLine[] = [...lines];
  for (let row = padded.length; row < rows; row += 1) {
    padded.push({ row, text: '' });
  }
  return padded;
}

function assertNativeSnapshot(snapshot: unknown): TerminalSnapshot {
  invariant(
    snapshot !== null && typeof snapshot === 'object',
    'libghostty-vt snapshot must be an object',
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

  assertPositiveInteger(candidate.cols, 'snapshot cols must be positive');
  assertPositiveInteger(candidate.rows, 'snapshot rows must be positive');
  assertNonNegativeInteger(
    candidate.cursorRow,
    'snapshot cursorRow must be non-negative',
  );
  assertNonNegativeInteger(
    candidate.cursorCol,
    'snapshot cursorCol must be non-negative',
  );
  invariant(
    candidate.cursorRow < candidate.rows,
    'snapshot cursorRow must be within rows',
  );
  invariant(
    candidate.cursorCol < candidate.cols,
    'snapshot cursorCol must be within cols',
  );
  invariant(
    typeof candidate.isAltScreen === 'boolean',
    'snapshot isAltScreen must be a boolean',
  );

  const visibleLines = validateNativeVisibleLines(
    candidate.visibleLines,
    'snapshot.visibleLines',
  );
  // The native ReadLine path omits trailing blank rows, so it may emit fewer
  // than `rows` visible lines; snapshot() pads the gap to exactly `rows` to
  // match the canonical pad-to-rows form (see padVisibleLinesToRows). Only the
  // permissive upper bound is enforced here.
  invariant(
    visibleLines.length <= candidate.rows,
    'snapshot visible line count must fit terminal rows',
  );
  const scrollbackLines =
    candidate.scrollbackLines === undefined
      ? undefined
      : validateNativeVisibleLines(
          candidate.scrollbackLines,
          'snapshot.scrollbackLines',
        );
  const cells =
    candidate.cells === undefined
      ? undefined
      : validateNativeCells(candidate.cells);

  return {
    cols: candidate.cols,
    rows: candidate.rows,
    cursorRow: candidate.cursorRow,
    cursorCol: candidate.cursorCol,
    isAltScreen: candidate.isAltScreen,
    visibleLines,
    ...(scrollbackLines === undefined ? {} : { scrollbackLines }),
    ...(cells === undefined ? {} : { cells }),
  };
}

function validateNativeCells(cells: unknown): NativeSnapshotCell[] {
  invariant(Array.isArray(cells), 'snapshot cells must be an array');

  return cells.map((cell, index) => {
    invariant(
      cell !== null && typeof cell === 'object',
      `snapshot.cells[${String(index)}] must be an object`,
    );
    const candidate = cell as {
      row?: unknown;
      col?: unknown;
      text?: unknown;
      width?: unknown;
      bold?: unknown;
      italic?: unknown;
      underline?: unknown;
      foreground?: unknown;
      background?: unknown;
    };
    assertNonNegativeInteger(
      candidate.row,
      `snapshot.cells[${String(index)}].row must be non-negative`,
    );
    assertNonNegativeInteger(
      candidate.col,
      `snapshot.cells[${String(index)}].col must be non-negative`,
    );
    assertString(
      candidate.text,
      `snapshot.cells[${String(index)}].text must be a string`,
    );
    assertPositiveInteger(
      candidate.width,
      `snapshot.cells[${String(index)}].width must be positive`,
    );

    const validatedCell: NativeSnapshotCell = {
      row: candidate.row,
      col: candidate.col,
      text: candidate.text,
      width: candidate.width,
    };
    copyOptionalBoolean(candidate, validatedCell, 'bold');
    copyOptionalBoolean(candidate, validatedCell, 'italic');
    copyOptionalBoolean(candidate, validatedCell, 'underline');
    copyOptionalString(candidate, validatedCell, 'foreground');
    copyOptionalString(candidate, validatedCell, 'background');
    return validatedCell;
  });
}

function copyOptionalBoolean(
  source: { [key: string]: unknown },
  target: NativeSnapshotCell,
  key: NativeSnapshotBooleanKey,
): void {
  const value = source[key];
  invariant(
    value === undefined || typeof value === 'boolean',
    `snapshot cell ${key} must be a boolean when provided`,
  );
  if (typeof value === 'boolean') {
    target[key] = value;
  }
}

function copyOptionalString(
  source: { [key: string]: unknown },
  target: NativeSnapshotCell,
  key: NativeSnapshotStringKey,
): void {
  const value = source[key];
  invariant(
    value === undefined || typeof value === 'string',
    `snapshot cell ${key} must be a string when provided`,
  );
  if (typeof value === 'string') {
    target[key] = value;
  }
}

function toStyledCell(cell: NativeSnapshotCell): SnapshotCell {
  return {
    char: cell.text,
    ...(cell.foreground === undefined ? {} : { fg: cell.foreground }),
    ...(cell.background === undefined ? {} : { bg: cell.background }),
    ...(cell.bold === undefined ? {} : { bold: cell.bold }),
    ...(cell.italic === undefined ? {} : { italic: cell.italic }),
    ...(cell.underline === undefined ? {} : { underline: cell.underline }),
  };
}

/**
 * Pack native cell records into a **column-indexed** `SnapshotCell[]` per row,
 * so that `cells[col]` is the cell at terminal column `col`. The native
 * snapshot emits one record per occupied column and represents a wide glyph
 * (CJK/emoji, `width: 2`) as a single record with no record for the trailing
 * column. We place each record at its `col` and emit an empty spacer for every
 * trailing column a wide glyph covers (and defensively for any gap), keeping
 * array index aligned with the terminal column. This mirrors the `ghostty-web`
 * backend, which already emits one cell per column, and keeps index-as-column
 * consumers (e.g. the Session Dashboard projection and its cursor-cell
 * highlight) correct past a wide glyph. See coder/agent-tty#112.
 */
function mapNativeCells(
  nativeCells: readonly NativeSnapshotCell[] | undefined,
): SemanticSnapshot['cells'] | undefined {
  if (nativeCells === undefined) {
    return undefined;
  }

  const grouped = new Map<number, NativeSnapshotCell[]>();
  for (const cell of nativeCells) {
    const rowCells = grouped.get(cell.row) ?? [];
    rowCells.push(cell);
    grouped.set(cell.row, rowCells);
  }

  return [...grouped.entries()]
    .sort(([leftRow], [rightRow]) => leftRow - rightRow)
    .map(([lineNumber, rowCells]) => {
      const sorted = [...rowCells].sort((left, right) => left.col - right.col);
      const cells: SnapshotCell[] = [];
      for (const cell of sorted) {
        // Fill any gap so the next record lands at its true column.
        while (cells.length < cell.col) {
          cells.push({ char: '' });
        }
        const styled = toStyledCell(cell);
        cells.push(styled);
        // A wide glyph covers its trailing column(s): emit an empty spacer
        // carrying the glyph's styling so the trailing half shades correctly
        // and the array index stays aligned with the terminal column.
        for (let span = 1; span < cell.width; span += 1) {
          cells.push({ ...styled, char: '' });
        }
      }
      return { lineNumber, cells };
    });
}

export class LibghosttyVtBackend implements RendererBackend {
  public readonly rendererBackend = 'libghostty-vt';
  public isBooted = false;

  private readonly fallbackFactory: NonNullable<
    LibghosttyVtBackendOptions['fallbackFactory']
  >;
  private readonly initialCols: number;
  private readonly initialRows: number;
  private readonly loadNative: NonNullable<
    LibghosttyVtBackendOptions['loadNative']
  >;
  private readonly logger: Logger;
  private readonly profile: RenderProfileConfig;
  private readonly scrollbackLimit: number;
  private readonly sessionId: string;

  private bootPromise: Promise<void> | null = null;
  private currentCols: number;
  private currentRows: number;
  private disposed = false;
  private initialReplayCols: number | null = null;
  private initialReplayRows: number | null = null;
  private lastAppliedSeq = -1;
  private latestReplayInput: ReplayInput | null = null;
  private terminal: GhosttyVtTerminal | null = null;

  public constructor(
    sessionId: string,
    profile: RenderProfileConfig,
    options: LibghosttyVtBackendOptions = {},
  ) {
    invariant(sessionId.length > 0, 'sessionId must be a non-empty string');
    invariant(profile.name.length > 0, 'profile.name must be non-empty');

    const initialCols = options.initialCols ?? DEFAULT_COLS;
    const initialRows = options.initialRows ?? DEFAULT_ROWS;
    assertPositiveInteger(initialCols, 'initialCols must be positive');
    assertPositiveInteger(initialRows, 'initialRows must be positive');
    if (options.scrollbackLimit !== undefined) {
      assertNonNegativeInteger(
        options.scrollbackLimit,
        'scrollbackLimit must be non-negative when provided',
      );
    }
    if (options.logger !== undefined) {
      invariant(options.logger instanceof Logger, 'logger must be a Logger');
    }

    this.sessionId = sessionId;
    this.profile = Object.freeze({ ...profile });
    this.initialCols = initialCols;
    this.initialRows = initialRows;
    this.currentCols = initialCols;
    this.currentRows = initialRows;
    this.scrollbackLimit = options.scrollbackLimit ?? DEFAULT_SCROLLBACK_LIMIT;
    this.loadNative =
      options.loadNative ??
      (() =>
        import('@coder/libghostty-vt-node') as Promise<LibghosttyVtNativeModule>);
    this.fallbackFactory =
      options.fallbackFactory ??
      ((fallbackSessionId, fallbackProfile) =>
        new GhosttyWebBackend(fallbackSessionId, fallbackProfile));
    this.logger = options.logger ?? createProcessLogger();
  }

  public async boot(): Promise<void> {
    this.assertNotDisposed('boot()');
    if (this.isBooted) {
      return;
    }
    if (this.bootPromise !== null) {
      await this.bootPromise;
      return;
    }

    this.bootPromise = this.bootInternal().finally(() => {
      this.bootPromise = null;
    });
    await this.bootPromise;
  }

  public async replayTo(input: ReplayInput): Promise<ReplayState> {
    await Promise.resolve();
    const terminal = this.requireTerminal('replayTo()');
    invariant(
      input.sessionId === this.sessionId,
      `replay input session ${input.sessionId} does not match backend session ${this.sessionId}`,
    );
    assertPositiveInteger(
      input.initialCols,
      'replay input initialCols must be positive',
    );
    assertPositiveInteger(
      input.initialRows,
      'replay input initialRows must be positive',
    );
    assertNonNegativeInteger(
      input.targetSeq,
      'replay input targetSeq must be non-negative',
    );
    invariant(
      input.targetSeq >= this.lastAppliedSeq,
      'stateful LibghosttyVtBackend cannot rewind from seq ' +
        String(this.lastAppliedSeq) +
        ' to ' +
        String(input.targetSeq),
    );

    if (this.initialReplayCols === null || this.initialReplayRows === null) {
      terminal.resize(input.initialCols, input.initialRows);
      this.initialReplayCols = input.initialCols;
      this.initialReplayRows = input.initialRows;
      this.currentCols = input.initialCols;
      this.currentRows = input.initialRows;
    } else {
      invariant(
        this.initialReplayCols === input.initialCols &&
          this.initialReplayRows === input.initialRows,
        'replay input initial dimensions changed after first replay',
      );
    }

    let previousEventSeq = -1;
    let highestProcessedSeq = this.lastAppliedSeq;
    for (const event of input.events) {
      assertNonNegativeInteger(
        event.seq,
        'replay event seq must be non-negative',
      );
      invariant(
        event.seq > previousEventSeq,
        'replay events must be ordered by strictly increasing seq values',
      );
      previousEventSeq = event.seq;

      if (event.seq <= this.lastAppliedSeq) {
        continue;
      }
      if (event.seq > input.targetSeq) {
        break;
      }

      switch (event.type) {
        case 'output':
          terminal.feed(event.payload.data);
          break;
        case 'resize':
          assertPositiveInteger(
            event.payload.cols,
            'resize event cols must be positive',
          );
          assertPositiveInteger(
            event.payload.rows,
            'resize event rows must be positive',
          );
          terminal.resize(event.payload.cols, event.payload.rows);
          this.currentCols = event.payload.cols;
          this.currentRows = event.payload.rows;
          break;
        case 'marker':
        case 'input_text':
        case 'input_paste':
        case 'input_keys':
        case 'input_run':
        case 'run_complete':
        case 'signal':
        case 'exit':
          break;
        default:
          unreachable(event, 'unsupported replay event type');
      }

      highestProcessedSeq = event.seq;
    }

    if (highestProcessedSeq < 0) {
      highestProcessedSeq = input.targetSeq;
    }
    this.lastAppliedSeq = highestProcessedSeq;
    this.latestReplayInput = cloneReplayInput(input);

    const snapshot = assertNativeSnapshot(terminal.snapshot());
    this.assertSnapshotDimensions(snapshot);
    this.currentCols = snapshot.cols;
    this.currentRows = snapshot.rows;

    return {
      lastSeq: this.lastAppliedSeq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursorRow: snapshot.cursorRow,
      cursorCol: snapshot.cursorCol,
    };
  }

  public async snapshot(options?: SnapshotOptions): Promise<SemanticSnapshot> {
    await Promise.resolve();
    const terminal = this.requireTerminal('snapshot()');
    invariant(
      this.lastAppliedSeq >= 0,
      'snapshot() requires replayTo() to advance to a non-negative sequence first',
    );
    const nativeSnapshot = assertNativeSnapshot(terminal.snapshot(options));
    this.assertSnapshotDimensions(nativeSnapshot);
    this.currentCols = nativeSnapshot.cols;
    this.currentRows = nativeSnapshot.rows;

    const semanticSnapshot = {
      sessionId: this.sessionId,
      capturedAtSeq: this.lastAppliedSeq,
      cols: nativeSnapshot.cols,
      rows: nativeSnapshot.rows,
      cursorRow: nativeSnapshot.cursorRow,
      cursorCol: nativeSnapshot.cursorCol,
      isAltScreen: nativeSnapshot.isAltScreen,
      visibleLines: padVisibleLinesToRows(
        nativeSnapshot.visibleLines,
        nativeSnapshot.rows,
      ),
      ...(nativeSnapshot.scrollbackLines === undefined
        ? {}
        : { scrollbackLines: nativeSnapshot.scrollbackLines }),
      ...(nativeSnapshot.cells === undefined
        ? {}
        : { cells: mapNativeCells(nativeSnapshot.cells) }),
    };

    return SemanticSnapshotSchema.parse(semanticSnapshot);
  }

  public async screenshot(
    outputPath: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult> {
    this.assertNotDisposed('screenshot()');
    invariant(
      this.latestReplayInput !== null,
      'screenshot() requires replayTo() before ghostty-web fallback can render',
    );
    invariant(
      outputPath.length > 0,
      'screenshot outputPath must be a non-empty string',
    );
    invariant(isAbsolute(outputPath), 'screenshot outputPath must be absolute');

    const fallback = await this.createFallbackBackend();
    try {
      await fallback.replayTo(this.latestReplayInput);
      return await fallback.screenshot(outputPath, options);
    } finally {
      await fallback.dispose();
    }
  }

  public async getVisibleText(): Promise<string> {
    await Promise.resolve();
    const terminal = this.requireTerminal('getVisibleText()');
    const visibleText = terminal.getVisibleText();
    assertString(visibleText, 'libghostty-vt visible text must be a string');
    return visibleText;
  }

  public dispose(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    this.disposed = true;
    this.isBooted = false;
    const terminal = this.terminal;
    this.terminal = null;
    if (terminal !== null) {
      terminal.dispose();
    }
    return Promise.resolve();
  }

  private async bootInternal(): Promise<void> {
    try {
      const native = await this.loadNative();
      invariant(
        typeof native.createTerminal === 'function',
        'libghostty-vt native module createTerminal must be a function',
      );

      if (typeof native.getNativeInfo === 'function') {
        try {
          this.logger.debug('Loaded libghostty-vt native renderer', {
            nativeInfo: native.getNativeInfo(),
          });
        } catch (error) {
          this.logger.debug('libghostty-vt native info unavailable', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.terminal = native.createTerminal({
        cols: this.initialCols,
        rows: this.initialRows,
        scrollbackLimit: this.scrollbackLimit,
      });
      this.assertTerminalShape(this.terminal);
      this.currentCols = this.initialCols;
      this.currentRows = this.initialRows;
      this.isBooted = true;
    } catch (error) {
      this.terminal = null;
      this.isBooted = false;
      throw new Error(
        'Failed to boot renderer libghostty-vt via optional dependency @coder/libghostty-vt-node. Install a supported optional native package or retry with --renderer ghostty-web.',
        { cause: error },
      );
    }
  }

  private async createFallbackBackend(): Promise<RendererBackend> {
    const fallback = this.fallbackFactory(this.sessionId, this.profile);
    invariant(
      fallback.rendererBackend !== this.rendererBackend,
      'libghostty-vt screenshot fallback must use a different renderer backend',
    );
    try {
      await fallback.boot();
      return fallback;
    } catch (error) {
      try {
        await fallback.dispose();
      } catch {
        // Preserve the original fallback boot error; dispose is best effort.
      }
      throw error;
    }
  }

  private assertNotDisposed(methodName: string): void {
    invariant(
      !this.disposed,
      `LibghosttyVtBackend ${methodName} cannot be used after dispose()`,
    );
  }

  private requireTerminal(methodName: string): GhosttyVtTerminal {
    this.assertNotDisposed(methodName);
    invariant(
      this.isBooted && this.terminal !== null,
      `LibghosttyVtBackend ${methodName} requires boot() first`,
    );
    return this.terminal;
  }

  private assertTerminalShape(
    terminal: unknown,
  ): asserts terminal is GhosttyVtTerminal {
    invariant(
      terminal !== null && typeof terminal === 'object',
      'libghostty-vt terminal must be an object',
    );
    const candidate = terminal as Partial<GhosttyVtTerminal>;
    invariant(
      typeof candidate.feed === 'function',
      'terminal.feed is required',
    );
    invariant(
      typeof candidate.resize === 'function',
      'terminal.resize is required',
    );
    invariant(
      typeof candidate.snapshot === 'function',
      'terminal.snapshot is required',
    );
    invariant(
      typeof candidate.getVisibleText === 'function',
      'terminal.getVisibleText is required',
    );
    invariant(
      typeof candidate.dispose === 'function',
      'terminal.dispose is required',
    );
  }

  private assertSnapshotDimensions(snapshot: TerminalSnapshot): void {
    invariant(
      snapshot.cols === this.currentCols,
      `native snapshot cols ${String(snapshot.cols)} must match current cols ${String(this.currentCols)}`,
    );
    invariant(
      snapshot.rows === this.currentRows,
      `native snapshot rows ${String(snapshot.rows)} must match current rows ${String(this.currentRows)}`,
    );
  }
}
