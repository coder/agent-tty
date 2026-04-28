/**
 * Run-completion sentinels are framed as APC control strings:
 *   ESC _ agent-tty:run-complete:<marker> ESC \
 *
 * APC gives agent-tty a private ESC-based control string whose bytes are easy to
 * recognize before PTY output reaches the event log, while the ST terminator
 * (ESC backslash) makes the frame boundary explicit. The scanner does not rely
 * on renderer filtering and removes only exact active frames for production run
 * markers. Production markers have a fixed length, so two active sentinels
 * cannot prefix each other.
 */

import { invariant } from '../util/assert.js';

export const RUN_COMPLETE_SENTINEL_PREFIX = '\x1b_agent-tty:run-complete:';
export const RUN_COMPLETE_SENTINEL_SUFFIX = '\x1b\\';
export const RUN_MARKER_PATTERN = /^__AT_MARKER_([0-9a-f]{32})__$/u;

const MIN_TOLERANT_ECHO_PREFIX_LENGTH = String.raw`printf '\033\137`.length;
const ESC_CODE = 0x1b;
const POSTAMBLE_ECHO_START_CODE = 'p'.charCodeAt(0);

export type SentinelPiece =
  | { type: 'output'; data: string }
  | { type: 'run_complete'; marker: string };

interface ActiveSentinel {
  marker: string;
  sentinel: string;
}

interface TolerantEchoCandidate {
  marker: string;
  echo: string;
  index: number;
}

interface TolerantEchoStripState {
  candidates: TolerantEchoCandidate[];
  dropControl: 'escape' | 'csi' | null;
}

interface ActivePostambleEcho {
  echoes: readonly string[];
}

function assertRunMarker(marker: string): void {
  invariant(typeof marker === 'string', 'marker must be a string');
  invariant(
    RUN_MARKER_PATTERN.test(marker),
    'run marker must match expected format',
  );
}

function assertNonEmptyString(value: string, label: string): void {
  invariant(
    typeof value === 'string' && value.length > 0,
    `${label} must be a non-empty string`,
  );
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;

  while (
    index < maxLength &&
    left.charCodeAt(index) === right.charCodeAt(index)
  ) {
    index += 1;
  }

  return index;
}

function pushOutputPiece(pieces: SentinelPiece[], data: string): void {
  if (data.length > 0) {
    pieces.push({ type: 'output', data });
  }
}

function postambleEchoVariants(postamble: string): readonly string[] {
  assertNonEmptyString(postamble, 'postamble');
  invariant(
    postamble.endsWith('\n'),
    'run-completion postamble must end with newline',
  );

  const crlfEcho = `${postamble.slice(0, -1)}\r\n`;
  return crlfEcho === postamble ? [postamble] : [crlfEcho, postamble];
}

export function buildRunCompleteSentinel(marker: string): string {
  assertRunMarker(marker);

  return `${RUN_COMPLETE_SENTINEL_PREFIX}${marker}${RUN_COMPLETE_SENTINEL_SUFFIX}`;
}

/**
 * Removes the shell's echo of agent-tty's injected completion postamble while
 * preserving command output that can arrive between echoed postamble bytes.
 * Canonical TTY echo and readline repainting can interleave command output or
 * cursor controls into the echoed postamble, so after a long exact prefix match
 * this sanitizer drops only the remaining expected postamble bytes and known
 * CSI repaint controls; nonmatching bytes continue through as user output.
 */
export class RunCompletionPostambleEchoSanitizer {
  readonly #activeEchoes = new Map<string, ActivePostambleEcho>();
  #tolerantStripState: TolerantEchoStripState | null = null;
  #pendingTail = '';

  public register(marker: string, postamble: string): void {
    assertRunMarker(marker);

    this.#activeEchoes.set(marker, {
      echoes: postambleEchoVariants(postamble),
    });
    this.#assertPendingTailBound();
  }

  public deregister(marker: string): string {
    assertRunMarker(marker);
    this.#activeEchoes.delete(marker);

    if (this.#tolerantStripState !== null) {
      const candidates = this.#tolerantStripState.candidates.filter(
        (candidate) => candidate.marker !== marker,
      );
      this.#tolerantStripState =
        candidates.length === 0
          ? null
          : { candidates, dropControl: this.#tolerantStripState.dropControl };
    }

    if (this.#pendingTail.length === 0) {
      return '';
    }

    const pendingTail = this.#pendingTail;
    this.#pendingTail = '';
    return this.#stripBuffer(pendingTail, false);
  }

  public feed(chunk: string): string {
    invariant(typeof chunk === 'string', 'chunk must be a string');

    if (chunk.length === 0) {
      return '';
    }

    if (!this.hasActiveEchoes() && this.#tolerantStripState === null) {
      invariant(
        this.#pendingTail.length === 0,
        'postamble echo pending tail must be empty when no echoes are active',
      );
      return chunk;
    }

    const buffer = `${this.#pendingTail}${chunk}`;
    this.#pendingTail = '';
    return this.#stripBuffer(buffer, false);
  }

  public flush(): string {
    if (this.#pendingTail.length === 0) {
      return '';
    }

    const pendingTail = this.#pendingTail;
    this.#pendingTail = '';
    return this.#stripBuffer(pendingTail, true);
  }

  public hasActiveEchoes(): boolean {
    return this.#activeEchoes.size > 0;
  }

  #stripBuffer(buffer: string, isFinal: boolean): string {
    if (buffer.length === 0) {
      return '';
    }

    if (!this.hasActiveEchoes() && this.#tolerantStripState === null) {
      invariant(
        this.#pendingTail.length === 0,
        'postamble echo pending tail must stay empty without active echoes',
      );
      return buffer;
    }

    let output = '';
    let outputStart = 0;
    let index = 0;

    while (index < buffer.length) {
      if (this.#tolerantStripState !== null) {
        output += buffer.slice(outputStart, index);
        const result = this.#consumeTolerantEchoByte(buffer, index);
        if (result.output.length > 0) {
          output += result.output;
        }
        index = result.nextIndex;
        outputStart = index;
        continue;
      }

      if (!this.hasActiveEchoes()) {
        output += buffer.slice(outputStart);
        outputStart = buffer.length;
        break;
      }

      if (buffer.charCodeAt(index) !== POSTAMBLE_ECHO_START_CODE) {
        index += 1;
        continue;
      }

      const matchedEcho = this.#findCompleteEchoMatch(buffer, index);
      if (matchedEcho !== undefined) {
        output += buffer.slice(outputStart, index);
        index += matchedEcho.length;
        outputStart = index;
        continue;
      }

      const remaining = buffer.slice(index);
      const tolerantMatch = this.#findTolerantEchoPrefixMatch(remaining);
      if (tolerantMatch !== undefined) {
        output += buffer.slice(outputStart, index);
        this.#tolerantStripState = {
          candidates: tolerantMatch.candidates,
          dropControl: null,
        };
        index += tolerantMatch.prefixLength;
        outputStart = index;
        continue;
      }

      if (!isFinal && this.#hasPartialEchoMatch(remaining)) {
        output += buffer.slice(outputStart, index);
        this.#setPendingTail(remaining);
        return output;
      }

      index += 1;
    }

    output += buffer.slice(outputStart);
    this.#assertPendingTailBound();
    return output;
  }

  #consumeTolerantEchoByte(
    buffer: string,
    index: number,
  ): { nextIndex: number; output: string } {
    const state = this.#tolerantStripState;
    invariant(state !== null, 'tolerant postamble echo strip state must exist');

    const char = buffer.charAt(index);
    invariant(char.length === 1, 'tolerant strip must consume one code unit');

    if (state.dropControl === 'escape') {
      state.dropControl = char === '[' ? 'csi' : null;
      return { nextIndex: index + 1, output: '' };
    }

    if (state.dropControl === 'csi') {
      if (/^[\x40-\x7e]$/u.test(char)) {
        state.dropControl = null;
      }
      return { nextIndex: index + 1, output: '' };
    }

    if (char === '\x1b') {
      state.dropControl = 'escape';
      return { nextIndex: index + 1, output: '' };
    }

    const advancedCandidates = state.candidates
      .filter(({ echo, index: candidateIndex }) =>
        echo.startsWith(char, candidateIndex),
      )
      .map((candidate) => ({
        ...candidate,
        index: candidate.index + 1,
      }));

    if (advancedCandidates.length === 0) {
      return { nextIndex: index + 1, output: char };
    }

    const completed = advancedCandidates.some(
      ({ echo, index: candidateIndex }) => candidateIndex === echo.length,
    );
    this.#tolerantStripState = completed
      ? null
      : { candidates: advancedCandidates, dropControl: null };
    return { nextIndex: index + 1, output: '' };
  }

  #findTolerantEchoPrefixMatch(
    remaining: string,
  ): { candidates: TolerantEchoCandidate[]; prefixLength: number } | undefined {
    let bestPrefixLength = 0;
    let candidates: TolerantEchoCandidate[] = [];

    for (const [marker, { echoes }] of this.#activeEchoes) {
      for (const echo of echoes) {
        const prefixLength = commonPrefixLength(remaining, echo);
        if (prefixLength < MIN_TOLERANT_ECHO_PREFIX_LENGTH) {
          continue;
        }
        if (prefixLength === echo.length) {
          continue;
        }

        if (prefixLength > bestPrefixLength) {
          bestPrefixLength = prefixLength;
          candidates = [];
        }
        if (prefixLength === bestPrefixLength) {
          candidates.push({ echo, index: prefixLength, marker });
        }
      }
    }

    if (bestPrefixLength === 0) {
      return undefined;
    }

    invariant(
      candidates.length > 0,
      'tolerant postamble echo prefix match must have candidates',
    );
    return { candidates, prefixLength: bestPrefixLength };
  }

  #findCompleteEchoMatch(buffer: string, index: number): string | undefined {
    let matchedEcho: string | undefined;

    for (const { echoes } of this.#activeEchoes.values()) {
      for (const echo of echoes) {
        if (!buffer.startsWith(echo, index)) {
          continue;
        }

        invariant(
          matchedEcho === undefined || matchedEcho === echo,
          'postamble echo matches must be unambiguous',
        );
        matchedEcho = echo;
      }
    }

    return matchedEcho;
  }

  #hasPartialEchoMatch(remaining: string): boolean {
    for (const { echoes } of this.#activeEchoes.values()) {
      for (const echo of echoes) {
        if (remaining.length < echo.length && echo.startsWith(remaining)) {
          return true;
        }
      }
    }

    return false;
  }

  #setPendingTail(tail: string): void {
    invariant(tail.length > 0, 'postamble echo pending tail must not be empty');
    invariant(
      this.hasActiveEchoes(),
      'postamble echo pending tail requires active echoes',
    );

    this.#pendingTail = tail;
    this.#assertPendingTailBound();
  }

  #maxActiveEchoLength(): number {
    let maxLength = 0;

    for (const { echoes } of this.#activeEchoes.values()) {
      for (const echo of echoes) {
        maxLength = Math.max(maxLength, echo.length);
      }
    }

    invariant(maxLength > 0, 'max active echo length requires active echoes');
    return maxLength;
  }

  #assertPendingTailBound(): void {
    if (!this.hasActiveEchoes()) {
      invariant(
        this.#pendingTail.length === 0,
        'postamble echo pending tail must be empty without active echoes',
      );
      return;
    }

    invariant(
      this.#pendingTail.length < this.#maxActiveEchoLength(),
      'postamble echo pending tail must be shorter than the longest active echo',
    );
  }
}

export class RunCompletionSentinelScanner {
  readonly #activeSentinels = new Map<string, ActiveSentinel>();
  #pendingTail = '';

  /**
   * Registers a marker as active. Re-registering an already-active marker is a
   * no-op; after the marker completes and deactivates, a later register() call
   * activates it again for a future run.
   */
  public register(marker: string): void {
    assertRunMarker(marker);

    if (this.#activeSentinels.has(marker)) {
      return;
    }

    this.#activeSentinels.set(marker, {
      marker,
      sentinel: buildRunCompleteSentinel(marker),
    });
    this.#assertPendingTailBound();
  }

  public feed(chunk: string): SentinelPiece[] {
    invariant(typeof chunk === 'string', 'chunk must be a string');

    if (chunk.length === 0) {
      return [];
    }

    if (!this.hasActiveMarkers()) {
      invariant(
        this.#pendingTail.length === 0,
        'pending tail must be empty when no run-completion markers are active',
      );
      return [{ type: 'output', data: chunk }];
    }

    const buffer = `${this.#pendingTail}${chunk}`;
    this.#pendingTail = '';
    return this.#scanBuffer(buffer, false);
  }

  public flush(): SentinelPiece[] {
    if (this.#pendingTail.length === 0) {
      return [];
    }

    const buffer = this.#pendingTail;
    this.#pendingTail = '';
    return this.#scanBuffer(buffer, true);
  }

  public hasActiveMarkers(): boolean {
    return this.#activeSentinels.size > 0;
  }

  #scanBuffer(buffer: string, isFinal: boolean): SentinelPiece[] {
    if (buffer.length === 0) {
      return [];
    }

    if (!this.hasActiveMarkers()) {
      invariant(
        this.#pendingTail.length === 0,
        'pending tail must stay empty when no run-completion markers are active',
      );
      return [{ type: 'output', data: buffer }];
    }

    const pieces: SentinelPiece[] = [];
    let outputStart = 0;
    let index = 0;

    while (index < buffer.length) {
      if (!this.hasActiveMarkers()) {
        pushOutputPiece(pieces, buffer.slice(outputStart));
        outputStart = buffer.length;
        break;
      }

      if (buffer.charCodeAt(index) !== ESC_CODE) {
        index += 1;
        continue;
      }

      const matched = this.#findCompleteSentinelMatch(buffer, index);
      if (matched !== undefined) {
        pushOutputPiece(pieces, buffer.slice(outputStart, index));
        pieces.push({ type: 'run_complete', marker: matched.marker });

        const deleted = this.#activeSentinels.delete(matched.marker);
        invariant(deleted, 'matched run-completion marker must be active');

        index += matched.sentinel.length;
        outputStart = index;
        continue;
      }

      const remaining = buffer.slice(index);
      if (!isFinal && this.#hasPartialSentinelMatch(remaining)) {
        pushOutputPiece(pieces, buffer.slice(outputStart, index));
        this.#setPendingTail(remaining);
        return pieces;
      }

      index += 1;
    }

    pushOutputPiece(pieces, buffer.slice(outputStart));
    this.#assertPendingTailBound();
    return pieces;
  }

  #findCompleteSentinelMatch(
    buffer: string,
    index: number,
  ): ActiveSentinel | undefined {
    let matched: ActiveSentinel | undefined;

    for (const activeSentinel of this.#activeSentinels.values()) {
      if (!buffer.startsWith(activeSentinel.sentinel, index)) {
        continue;
      }

      invariant(
        matched === undefined,
        'fixed-length run sentinels must match at most one active marker',
      );
      matched = activeSentinel;
    }

    return matched;
  }

  #hasPartialSentinelMatch(remaining: string): boolean {
    for (const { sentinel } of this.#activeSentinels.values()) {
      if (
        remaining.length < sentinel.length &&
        sentinel.startsWith(remaining)
      ) {
        return true;
      }
    }

    return false;
  }

  #setPendingTail(tail: string): void {
    invariant(tail.length > 0, 'pending tail must not be empty');
    invariant(
      this.hasActiveMarkers(),
      'pending tail requires active run-completion markers',
    );

    this.#pendingTail = tail;
    this.#assertPendingTailBound();
  }

  #maxActiveSentinelLength(): number {
    let maxLength = 0;

    for (const { sentinel } of this.#activeSentinels.values()) {
      maxLength = Math.max(maxLength, sentinel.length);
    }

    invariant(
      maxLength > 0,
      'max active sentinel length requires active run-completion markers',
    );
    return maxLength;
  }

  #assertPendingTailBound(): void {
    if (!this.hasActiveMarkers()) {
      invariant(
        this.#pendingTail.length === 0,
        'pending tail must be empty without active run-completion markers',
      );
      return;
    }

    invariant(
      this.#pendingTail.length < this.#maxActiveSentinelLength(),
      'pending tail must be shorter than the longest active sentinel',
    );
  }
}
