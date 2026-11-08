import type {
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from './types.js';
import type {
  MouseAction,
  MouseButton,
  MouseModifiers,
  RecordExportResult,
} from '../protocol/schemas.js';

export interface SnapshotOptions {
  includeScrollback?: boolean;
  includeCells?: boolean;
}

export interface ScreenshotOptions {
  showCursor?: boolean;
  /**
   * Called each time a backend that replays the log inside `screenshot()` (the
   * libghostty-vt one, in a second renderer) has booted that renderer or
   * finished a slice of the replay. It lets a caller that waits for the
   * screenshot tell that the replay moves forward.
   */
  onReplayProgress?: () => void;
}

export interface RendererBackend {
  /** Boot the renderer (lazy, idempotent). */
  boot(): Promise<void>;

  /** Apply replay events up to target sequence. */
  replayTo(input: ReplayInput): Promise<ReplayState>;

  /** Extract semantic snapshot of current visible state. */
  snapshot(options?: SnapshotOptions): Promise<SemanticSnapshot>;

  /** Capture a screenshot as PNG. */
  screenshot(
    outputPath: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult>;

  /** Get current visible text (for wait operations). */
  getVisibleText(): Promise<string>;

  /** Dispose the renderer and release resources. */
  dispose(): Promise<void>;

  /** Backend identifier for artifact metadata and debugging. */
  readonly rendererBackend: string;

  /** Whether the renderer is currently booted. */
  readonly isBooted: boolean;
}

export interface MouseEncodingInput {
  action: MouseAction;
  button?: MouseButton;
  row: number;
  col: number;
  cellWidth?: number;
  cellHeight?: number;
  modifiers: MouseModifiers;
  anyButtonPressed: boolean;
}

export interface MouseEncodingBackend extends RendererBackend {
  /** Encode one semantic mouse action using modes negotiated by the child. */
  encodeMouse(input: MouseEncodingInput): Buffer;
}

export function supportsMouseEncoding(
  backend: RendererBackend,
): backend is MouseEncodingBackend {
  return (
    'encodeMouse' in backend &&
    typeof (backend as Partial<MouseEncodingBackend>).encodeMouse === 'function'
  );
}

export interface VideoRecordingOptions {
  outputDir: string;
  size: { width: number; height: number };
}

export interface AcceleratedTimingOptions {
  mode: 'accelerated';
  maxGapMs: number;
  minFrameHoldMs: number;
  finalFrameHoldMs: number;
}

export interface RecordedTimingOptions {
  mode: 'recorded';
  finalFrameHoldMs: number;
}

export interface MaxSpeedTimingOptions {
  mode: 'max-speed';
  minFrameHoldMs: number;
  finalFrameHoldMs: number;
}

export type ReplayTimingOptions =
  | AcceleratedTimingOptions
  | RecordedTimingOptions
  | MaxSpeedTimingOptions;

/** One report that a timed replay makes to its caller. */
export interface ReplayProgress {
  /** Seq of the last event that the replay reached, or -1 before the first. */
  seq: number;
  /**
   * How long the replay waits on its timing schedule right after this report.
   * A caller that watches for stalls must not count that wait.
   */
  scheduledWaitMs: number;
}

export interface VideoCapableRendererBackend extends RendererBackend {
  /**
   * Replay events with controlled timing for video capture. `onProgress`
   * runs before each wait on the timing schedule, after each batch of
   * output that the replay writes to the renderer and after the renderer
   * resizes for a resize event.
   */
  replayWithTiming(
    input: ReplayInput,
    timing: ReplayTimingOptions,
    onProgress?: (progress: ReplayProgress) => void,
  ): Promise<ReplayState>;

  /** Finalize and save the video recording to the given path. */
  finalizeVideo(outputPath: string): Promise<void>;

  /** Resolves to `{}` instead of rejecting when the glyph check fails. */
  recordedMissingGlyphs(): Promise<RecordedGlyphFields>;
}

export type RecordedGlyphFields = Pick<
  Extract<RecordExportResult, { format: 'webm' }>,
  'missingGlyphs' | 'missingGlyphsTruncated'
>;
