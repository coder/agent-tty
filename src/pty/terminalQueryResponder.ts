import { invariant } from '../util/assert.js';

/**
 * agent-tty owns the PTY master and is therefore the terminal that programs
 * running inside a session talk to. Well-behaved programs probe the terminal at
 * startup — they query the background/foreground colors (OSC 10/11) to pick a
 * light or dark theme, and emit a Device Status Report (DSR, `ESC [ 5 n`) as a
 * sentinel to learn whether the terminal answers queries at all. Because the
 * host's PTY read loop only *consumes* output (to log it and replay it through
 * the renderer offline), nothing ever replied to these queries, so programs
 * timed out waiting. Neovim 0.12+ surfaces this as:
 *
 *   E1568: Terminal did not respond to DSR request for 'background' color.
 *
 * The warning text then lands in the very PNG/WebM captures agent-tty exists to
 * produce. This scanner answers the handful of startup queries that matter so
 * those programs proceed immediately, and reports the colors of agent-tty's
 * default render profile so a program's light/dark choice matches a
 * default-profile capture. The probe is answered once at session start, before
 * any capture profile is known, so a capture later requested with a different
 * `--profile` can still diverge from the advertised colors.
 *
 * The scanner is a small VT state machine rather than a regex sweep so that a
 * query split across PTY read boundaries (`ESC ] 1` then `1 ; ? BEL`) is still
 * recognized, and so a recognized pattern that appears spliced across two
 * unrelated chunks is never double-answered. It only ever *adds* replies; it
 * never inspects or alters the output stream that flows on to the event log.
 */

const ESC = 0x1b;
const ESC_CHAR = String.fromCharCode(ESC); // Same byte as ESC, for substring scans.
const BELL = 0x07;
const LEFT_SQUARE_BRACKET = 0x5b; // [ — introduces a CSI sequence after ESC.
const RIGHT_SQUARE_BRACKET = 0x5d; // ] — introduces an OSC sequence after ESC.
const REVERSE_SOLIDUS = 0x5c; // \ — the second byte of a 7-bit ST terminator (ESC \).
const C1_STRING_TERMINATOR = 0x9c; // 8-bit C1 String Terminator (ST); also ends an OSC.

const CSI_FINAL_BYTE_MIN = 0x40;
const CSI_FINAL_BYTE_MAX = 0x7e;
const CSI_PARAM_BYTE_MIN = 0x20;
const CSI_PARAM_BYTE_MAX = 0x3f;

/**
 * Recognized queries are only a few bytes long, so once accumulation exceeds
 * these caps the sequence cannot be one we answer. We stop growing the buffer
 * but keep tracking state until the sequence terminates, so a long sequence
 * (e.g. an OSC window-title update) never desynchronizes the scanner or grows
 * memory without bound.
 */
const MAX_CSI_PARAM_LENGTH = 32;
const MAX_OSC_PAYLOAD_LENGTH = 64;

type ScannerState = 'ground' | 'esc' | 'csi' | 'osc' | 'oscEsc';

export interface TerminalQueryResponderOptions {
  /** Background color (`#rrggbb`) reported for OSC 11 queries. */
  backgroundColor: string;
  /** Foreground color (`#rrggbb`) reported for OSC 10 queries. */
  foregroundColor: string;
}

function assertHexColor(value: string, label: string): void {
  invariant(
    /^#[0-9a-fA-F]{6}$/u.test(value),
    `${label} must be a "#rrggbb" hex color`,
  );
}

/**
 * Converts `#rrggbb` to the `rgb:rrrr/gggg/bbbb` payload xterm uses in OSC color
 * replies. xterm reports 16-bit-per-channel values, so each 8-bit byte is
 * duplicated (`0x1e` → `1e1e`). Neovim and other clients parse this form.
 */
function toOscColorPayload(hexColor: string): string {
  const red = hexColor.slice(1, 3).toLowerCase();
  const green = hexColor.slice(3, 5).toLowerCase();
  const blue = hexColor.slice(5, 7).toLowerCase();
  return `rgb:${red}${red}/${green}${green}/${blue}${blue}`;
}

export class TerminalQueryResponder {
  private state: ScannerState = 'ground';
  private buffer = '';
  private readonly backgroundPayload: string;
  private readonly foregroundPayload: string;

  constructor(options: TerminalQueryResponderOptions) {
    assertHexColor(options.backgroundColor, 'backgroundColor');
    assertHexColor(options.foregroundColor, 'foregroundColor');
    this.backgroundPayload = toOscColorPayload(options.backgroundColor);
    this.foregroundPayload = toOscColorPayload(options.foregroundColor);
  }

  /**
   * Feeds one chunk of PTY output and returns the bytes to write back to the
   * child as query replies — an empty string when the chunk holds no recognized
   * query. Scanner state persists across calls, so a query straddling a chunk
   * boundary is answered when its final byte arrives.
   */
  consume(chunk: string): string {
    // Fast path: when no sequence is mid-parse and the chunk holds no ESC byte,
    // it cannot contain a query. A single native substring search lets the vast
    // majority of PTY output (plain text, build logs, file dumps) skip the
    // per-character scan entirely. The `ground` guard keeps a query split across
    // chunk boundaries correct — its tail chunk may legitimately carry no ESC.
    if (this.state === 'ground' && !chunk.includes(ESC_CHAR)) {
      return '';
    }
    let response = '';
    for (let index = 0; index < chunk.length; index += 1) {
      response += this.step(chunk[index] as string);
    }
    return response;
  }

  private step(char: string): string {
    const code = char.charCodeAt(0);
    switch (this.state) {
      case 'ground':
        if (code === ESC) {
          this.state = 'esc';
        }
        return '';
      case 'esc':
        return this.stepEsc(code);
      case 'csi':
        return this.stepCsi(char, code);
      case 'osc':
        return this.stepOsc(char, code);
      case 'oscEsc':
        return this.stepOscEsc(code);
    }
  }

  private stepEsc(code: number): string {
    if (code === LEFT_SQUARE_BRACKET) {
      this.state = 'csi';
      this.buffer = '';
    } else if (code === RIGHT_SQUARE_BRACKET) {
      this.state = 'osc';
      this.buffer = '';
    } else if (code !== ESC) {
      // Any other escape sequence is one we do not answer; ignore it. A repeated
      // ESC keeps us waiting for the introducer of a fresh sequence.
      this.state = 'ground';
    }
    return '';
  }

  // A stray byte aborts the in-progress CSI/OSC sequence: the buffer is dropped,
  // and a fresh ESC begins another sequence while anything else returns to
  // ground. Centralized so both call sites stay in lockstep.
  private abortSequence(code: number): string {
    this.buffer = '';
    this.state = code === ESC ? 'esc' : 'ground';
    return '';
  }

  private stepCsi(char: string, code: number): string {
    if (code >= CSI_FINAL_BYTE_MIN && code <= CSI_FINAL_BYTE_MAX) {
      const params = this.buffer;
      this.state = 'ground';
      this.buffer = '';
      // DSR — Device Status Report. `ESC [ 5 n` asks "are you OK?"; the
      // conventional reply is `ESC [ 0 n` ("terminal OK"). Programs use this as
      // the sentinel that tells them the terminal answers queries at all.
      if (params === '5' && char === 'n') {
        return '\x1b[0n';
      }
      return '';
    }
    if (code >= CSI_PARAM_BYTE_MIN && code <= CSI_PARAM_BYTE_MAX) {
      if (this.buffer.length < MAX_CSI_PARAM_LENGTH) {
        this.buffer += char;
      }
      return '';
    }
    // A byte outside the parameter/final ranges aborts the CSI sequence.
    return this.abortSequence(code);
  }

  private stepOsc(char: string, code: number): string {
    // An OSC string terminates on BEL or the 8-bit C1 String Terminator (0x9c);
    // the 7-bit ST (ESC \) is handled via the oscEsc state. Recognizing the C1
    // ST matters even though we answer no C1-introduced queries: without it, an
    // OSC terminated that way (e.g. a window-title update) would never close, so
    // the scanner would stay in `osc` and swallow the next genuine query.
    if (code === BELL || code === C1_STRING_TERMINATOR) {
      return this.dispatchOsc(char);
    }
    if (code === ESC) {
      this.state = 'oscEsc';
      return '';
    }
    if (this.buffer.length < MAX_OSC_PAYLOAD_LENGTH) {
      this.buffer += char;
    }
    return '';
  }

  private stepOscEsc(code: number): string {
    if (code === REVERSE_SOLIDUS) {
      // ESC \ is the String Terminator (ST).
      return this.dispatchOsc('\x1b\\');
    }
    // The ESC did not form a 7-bit ST, so it aborts the OSC.
    return this.abortSequence(code);
  }

  private dispatchOsc(terminator: string): string {
    const payload = this.buffer;
    this.state = 'ground';
    this.buffer = '';
    // OSC 11 — query background color. The `?` marks a query; a set request
    // carries a color value instead and is left untouched.
    if (payload === '11;?') {
      return `\x1b]11;${this.backgroundPayload}${terminator}`;
    }
    // OSC 10 — query foreground color.
    if (payload === '10;?') {
      return `\x1b]10;${this.foregroundPayload}${terminator}`;
    }
    return '';
  }
}
