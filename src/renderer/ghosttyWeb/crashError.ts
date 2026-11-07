// The ghostty-web page crashed while it replayed output. The cause that we
// know: ghostty-web 0.4.0 keeps the old cells on the alternate screen when
// `?47h` or `?1047h` follows a full reset (RIS, `ESC c`). Output over a cell
// that holds a combining mark or another grapheme cluster then makes the WASM
// module fault, and Chromium kills the page ("Target crashed"). The shortest
// input is `a`, U+0301, `ESC c`, `ESC [ ? 4 7 h`, `o`. Upstream ghostty-web
// has no release with a fix. Remove this error when ghostty-web has one.
const CRASH_EXPLANATION =
  "ghostty-web crashed while it replayed this session's output. One known cause is a ghostty-web 0.4.0 bug: after a full reset (ESC c), the alternate screen (?47h or ?1047h) keeps the old cells, and output over a combining mark or other grapheme cluster there crashes the page. The libghostty-vt renderer and `record export --format svg` are not affected.";

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
