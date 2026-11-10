// The ghostty-web page crashed while it replayed output. Chromium reports it
// as "Target crashed". ghostty-web 0.4.0 has more than one WASM fault that does
// this ("memory access out of bounds" in the WASM module), and different
// inputs reach them. A crash that has no reset, no resize and no alternate
// screen is known (a plain print of many lines that hold combining marks). So
// the message must not name one input as the cause.
//
// One known input: after a full reset (RIS, `ESC c`), ghostty-web 0.4.0 keeps
// the old cells on the alternate screen when `?47h` or `?1047h` follows.
// Output over a cell that holds a combining mark or another grapheme cluster
// then faults the WASM module. The shortest input is `a`, U+0301, `ESC c`,
// `ESC [ ? 4 7 h`, `o`. Upstream issue:
// https://github.com/coder/ghostty-web/issues/215. No ghostty-web release has
// a fix for any of the faults yet. When a release fixes them, remove this
// error, or invert the tests that carry a KNOWN-BUG header, and bump the
// version that the message names.
const CRASH_EXPLANATION =
  "ghostty-web crashed while it replayed this session's output. This is a bug in the WASM module of ghostty-web 0.4.0, which several different inputs trigger. One known cause is https://github.com/coder/ghostty-web/issues/215 (a full reset, ESC c, then ?47h or ?1047h, then output over a combining mark or other grapheme cluster). The default libghostty-vt renderer (`snapshot` and `wait`), `record export --format svg` and `record export --format asciicast` do not use ghostty-web.";

const PAGE_CRASH_PATTERN = /Target crashed/u;

export class GhosttyWebCrashedError extends Error {
  public constructor(cause: Error) {
    super(`${CRASH_EXPLANATION} (${cause.message.trim()})`, { cause });
    this.name = 'GhosttyWebCrashedError';
  }
}

// `error` as thrown by a page call during a replay. Returns the crash error
// when the page died, and `error` itself for every other failure.
export function describeReplayFailure(error: unknown): unknown {
  return error instanceof Error && PAGE_CRASH_PATTERN.test(error.message)
    ? new GhosttyWebCrashedError(error)
    : error;
}
