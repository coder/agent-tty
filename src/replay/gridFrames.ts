import { buildReplayInput } from '../host/replay.js';
import type {
  EventRecord,
  SessionRecord,
  SnapshotCell,
} from '../protocol/schemas.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import type { RendererBackend } from '../renderer/backend.js';
import { createRendererBackend } from '../renderer/registry.js';
import type {
  RenderProfileConfig,
  ReplayInput,
  SemanticSnapshot,
} from '../renderer/types.js';
import { invariant } from '../util/assert.js';

/** Matches the recorded-timing WebM export's final frame hold. */
const DEFAULT_FINAL_FRAME_HOLD_MS = 1_000;

export type GridFrameMode = 'final' | 'timeline';

export interface GridFrame {
  capturedAtSeq: number;
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  /** Dense visible grid: `lines[row]` lists styled cells by column. */
  lines: SnapshotCell[][];
  holdMs: number;
}

export interface CaptureGridFramesOptions {
  sessionId: string;
  manifest: SessionRecord;
  events: readonly EventRecord[];
  profile: RenderProfileConfig;
  /** `final` captures only the last frame; `timeline` captures every boundary. */
  mode: GridFrameMode;
  finalFrameHoldMs?: number;
}

export interface GridFrameCapture {
  frames: GridFrame[];
  capturedAtSeq: number;
  cols: number;
  rows: number;
  rendererBackend: string;
  outputEventCount: number;
  resizeEventCount: number;
  /** Sum of frame holds; the recorded visual timeline plus the final hold. */
  timelineDurationMs: number;
}

export interface GridFrameDeps {
  backendFactory?: (
    sessionId: string,
    profile: RenderProfileConfig,
  ) => RendererBackend | Promise<RendererBackend>;
}

interface FrameBoundary {
  seq: number;
  tsMs: number;
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  invariant(
    Number.isFinite(timestamp),
    `${label} must be a valid ISO timestamp`,
  );
  return timestamp;
}

/**
 * Collect the seq boundaries where the visible grid may have changed: only
 * `output` and `resize` events mutate the screen, and events sharing one
 * timestamp are coalesced into the last seq of that instant so the frame count
 * stays bounded by the number of distinct recorded instants.
 */
function collectFrameBoundaries(input: ReplayInput): {
  boundaries: FrameBoundary[];
  outputEventCount: number;
  resizeEventCount: number;
} {
  const boundaries: FrameBoundary[] = [];
  let outputEventCount = 0;
  let resizeEventCount = 0;

  for (const event of input.events) {
    if (event.seq > input.targetSeq) {
      break;
    }
    if (event.type !== 'output' && event.type !== 'resize') {
      continue;
    }
    if (event.type === 'output') {
      outputEventCount += 1;
    } else {
      resizeEventCount += 1;
    }

    const tsMs = parseTimestamp(
      event.ts,
      `event ${String(event.seq)} timestamp`,
    );
    const lastBoundary = boundaries.at(-1);
    if (lastBoundary !== undefined) {
      invariant(
        tsMs >= lastBoundary.tsMs,
        'event timestamps must be non-decreasing',
      );
      if (tsMs === lastBoundary.tsMs) {
        lastBoundary.seq = event.seq;
        continue;
      }
    }
    boundaries.push({ seq: event.seq, tsMs });
  }

  return { boundaries, outputEventCount, resizeEventCount };
}

function toGridFrame(snapshot: SemanticSnapshot, holdMs: number): GridFrame {
  invariant(
    snapshot.cells !== undefined,
    'grid frame snapshot must include styled cells',
  );

  const lines: SnapshotCell[][] = Array.from(
    { length: snapshot.rows },
    () => [],
  );
  for (const line of snapshot.cells) {
    invariant(
      line.lineNumber < snapshot.rows,
      'snapshot cell line must be within rows',
    );
    lines[line.lineNumber] = line.cells;
  }

  return {
    capturedAtSeq: snapshot.capturedAtSeq,
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursorRow: snapshot.cursorRow,
    cursorCol: snapshot.cursorCol,
    lines,
    holdMs,
  };
}

/** Canonical frame content key (ignores seq and hold) used for de-duplication. */
function frameContentKey(frame: GridFrame): string {
  return JSON.stringify([
    frame.cols,
    frame.rows,
    frame.cursorRow,
    frame.cursorCol,
    frame.lines.map((cells) =>
      cells.map((cell) => [
        cell.char,
        cell.fg ?? null,
        cell.bg ?? null,
        cell.bold ?? false,
        cell.italic ?? false,
        cell.underline ?? false,
        cell.width ?? 1,
      ]),
    ),
  ]);
}

async function createLibghosttyVtBackend(
  sessionId: string,
  profile: RenderProfileConfig,
  deps?: GridFrameDeps,
): Promise<RendererBackend> {
  const backendFactory =
    deps?.backendFactory ??
    ((factorySessionId: string, factoryProfile: RenderProfileConfig) =>
      createRendererBackend('libghostty-vt', factorySessionId, factoryProfile));
  return await backendFactory(sessionId, profile);
}

/**
 * Replay a session's event log offline through the libghostty-vt backend and
 * capture de-duplicated styled grid frames with recorded hold durations. This
 * intentionally never falls back to the browser renderer: when the optional
 * native package is unavailable the export fails with a clear error instead.
 */
export async function captureGridFrames(
  options: CaptureGridFramesOptions,
  deps?: GridFrameDeps,
): Promise<GridFrameCapture> {
  invariant(options.sessionId.length > 0, 'sessionId is required');
  invariant(options.events.length > 0, 'grid capture requires >=1 event');
  const finalFrameHoldMs =
    options.finalFrameHoldMs ?? DEFAULT_FINAL_FRAME_HOLD_MS;
  invariant(
    Number.isInteger(finalFrameHoldMs) && finalFrameHoldMs > 0,
    'finalFrameHoldMs must be a positive integer',
  );

  const replayInput = buildReplayInput(
    options.sessionId,
    options.manifest,
    options.events,
  );
  invariant(replayInput.targetSeq >= 0, 'grid capture requires >=1 event');

  const { boundaries, outputEventCount, resizeEventCount } =
    collectFrameBoundaries(replayInput);
  // Sessions without visual events still have a (blank) grid; capture it at
  // the final target seq.
  const captureBoundaries: FrameBoundary[] =
    options.mode === 'timeline' && boundaries.length > 0
      ? boundaries
      : [
          {
            seq: replayInput.targetSeq,
            tsMs: boundaries.at(-1)?.tsMs ?? 0,
          },
        ];

  const backend = await createLibghosttyVtBackend(
    options.sessionId,
    options.profile,
    deps,
  );

  try {
    try {
      await backend.boot();
    } catch (error) {
      throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
        message:
          'SVG export requires the libghostty-vt renderer. Install the optional @coder/libghostty-vt-node package and retry.',
        details: { rendererBackend: 'libghostty-vt' },
        cause: error,
      });
    }

    const frames: GridFrame[] = [];
    let previousContentKey: string | null = null;
    // Event cursor: each boundary replay feeds only the not-yet-applied event
    // suffix. Passing the full validated array per boundary would rescan from
    // index 0 every time (O(boundaries x events)). The backend skips events at
    // or below its last applied seq, so a contiguous suffix slice of the
    // already-validated events is equivalent.
    let nextEventIndex = 0;
    const sliceEventsThrough = (targetSeq: number) => {
      const startIndex = nextEventIndex;
      while (nextEventIndex < replayInput.events.length) {
        const event = replayInput.events[nextEventIndex];
        invariant(event !== undefined, 'event cursor index must be in range');
        if (event.seq > targetSeq) {
          break;
        }
        nextEventIndex += 1;
      }
      return replayInput.events.slice(startIndex, nextEventIndex);
    };

    for (const [index, boundary] of captureBoundaries.entries()) {
      const nextBoundary = captureBoundaries[index + 1];
      const holdMs =
        nextBoundary === undefined
          ? finalFrameHoldMs
          : nextBoundary.tsMs - boundary.tsMs;
      invariant(holdMs > 0, 'frame hold duration must be positive');

      await backend.replayTo({
        ...replayInput,
        events: sliceEventsThrough(boundary.seq),
        targetSeq: boundary.seq,
      });
      const snapshot = await backend.snapshot({ includeCells: true });
      const frame = toGridFrame(snapshot, holdMs);
      const contentKey = frameContentKey(frame);
      if (contentKey === previousContentKey) {
        const previousFrame = frames.at(-1);
        invariant(previousFrame !== undefined, 'previous frame must exist');
        previousFrame.holdMs += holdMs;
        continue;
      }
      frames.push(frame);
      previousContentKey = contentKey;
    }

    // Apply any trailing non-visual events so capturedAtSeq covers the log.
    if (replayInput.targetSeq > (captureBoundaries.at(-1)?.seq ?? -1)) {
      await backend.replayTo({
        ...replayInput,
        events: sliceEventsThrough(replayInput.targetSeq),
        targetSeq: replayInput.targetSeq,
      });
    }

    const finalFrame = frames.at(-1);
    invariant(finalFrame !== undefined, 'grid capture must produce >=1 frame');

    return {
      frames,
      capturedAtSeq: replayInput.targetSeq,
      cols: finalFrame.cols,
      rows: finalFrame.rows,
      rendererBackend: backend.rendererBackend,
      outputEventCount,
      resizeEventCount,
      timelineDurationMs: frames.reduce((sum, frame) => sum + frame.holdMs, 0),
    };
  } finally {
    await backend.dispose();
  }
}
