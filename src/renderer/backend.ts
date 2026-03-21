import type {
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from './types.js';

export interface RendererBackend {
  /** Boot the renderer (lazy, idempotent). */
  boot(): Promise<void>;

  /** Apply replay events up to target sequence. */
  replayTo(input: ReplayInput): Promise<ReplayState>;

  /** Extract semantic snapshot of current visible state. */
  snapshot(): Promise<SemanticSnapshot>;

  /** Capture a screenshot as PNG. */
  screenshot(outputPath: string): Promise<ScreenshotResult>;

  /** Get current visible text (for wait operations). */
  getVisibleText(): Promise<string>;

  /** Dispose the renderer and release resources. */
  dispose(): Promise<void>;

  /** Whether the renderer is currently booted. */
  readonly isBooted: boolean;
}
