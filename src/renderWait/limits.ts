export const MAX_WAIT_FOR_RENDER_TEXT_LENGTH = 1000;
export const MAX_WAIT_FOR_RENDER_REGEX_LENGTH = 200;
export const MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH = 50_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const RENDER_WAIT_POLL_INTERVAL_MS = 200;

// The host starts the stable clock at its first snapshot, one poll after the
// wait starts, and only a later snapshot can confirm it. Rounding the window
// up to whole polls would reject windows that render jitter lets pass.
export function screenStableMinimumMs(screenStableMs: number): number {
  return Math.max(
    screenStableMs + RENDER_WAIT_POLL_INTERVAL_MS,
    2 * RENDER_WAIT_POLL_INTERVAL_MS,
  );
}
