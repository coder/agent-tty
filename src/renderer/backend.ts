import type {
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from './types.js';

export interface SnapshotOptions {
  includeScrollback?: boolean;
}

export interface RendererBackend {
  /** Boot the renderer (lazy, idempotent). */
  boot(): Promise<void>;

  /** Apply replay events up to target sequence. */
  replayTo(input: ReplayInput): Promise<ReplayState>;

  /** Extract semantic snapshot of current visible state. */
  snapshot(options?: SnapshotOptions): Promise<SemanticSnapshot>;

  /** Capture a screenshot as PNG. */
  screenshot(outputPath: string): Promise<ScreenshotResult>;

  /** Get current visible text (for wait operations). */
  getVisibleText(): Promise<string>;

  /** Dispose the renderer and release resources. */
  dispose(): Promise<void>;

  /** Backend identifier for artifact metadata and debugging. */
  readonly rendererBackend: string;

  /** Whether the renderer is currently booted. */
  readonly isBooted: boolean;
}

export interface VideoRecordingOptions {
  outputDir: string;
  size: { width: number; height: number };
}

export interface AcceleratedTimingOptions {
  maxGapMs: number;
  minFrameHoldMs: number;
  finalFrameHoldMs: number;
}

export interface VideoCapableRendererBackend extends RendererBackend {
  /** Replay events with controlled timing for video capture. */
  replayWithTiming(
    input: ReplayInput,
    timing: AcceleratedTimingOptions,
  ): Promise<ReplayState>;

  /** Finalize and save the video recording to the given path. */
  finalizeVideo(outputPath: string): Promise<void>;
}
