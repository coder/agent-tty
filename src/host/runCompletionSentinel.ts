/**
 * Run-completion sentinels are framed as APC control strings:
 *   ESC _ agent-tty:run-complete:<marker> ESC \
 *
 * APC gives agent-tty a private ESC-based control string whose bytes are easy to
 * recognize before PTY output reaches the event log, while the ST terminator
 * (ESC backslash) makes the frame boundary explicit. Phase 3 will verify the
 * live ghostty-web renderer behavior; this scanner does not rely on renderer
 * filtering and removes only exact active frames.
 *
 * The scanner walks input left-to-right. If multiple active sentinels could
 * match at the same byte offset, the longest complete frame wins; if that
 * complete frame is a strict prefix of a longer active frame and more bytes
 * could still arrive, the scanner waits for the next chunk. Equal frames are
 * collapsed by idempotent marker registration.
 */

import { invariant } from '../util/assert.js';

export const RUN_COMPLETE_SENTINEL_PREFIX = '\x1b_agent-tty:run-complete:';
export const RUN_COMPLETE_SENTINEL_SUFFIX = '\x1b\\';
export const RUN_MARKER_PATTERN = /^__AT_MARKER_([0-9a-f]{32})__$/u;

export type SentinelPiece =
  | { type: 'output'; data: string }
  | { type: 'run_complete'; marker: string };

interface ActiveSentinel {
  marker: string;
  sentinel: string;
  order: number;
}

function assertNonEmptyString(value: string, label: string): void {
  invariant(
    typeof value === 'string' && value.length > 0,
    `${label} must be a non-empty string`,
  );
}

function pushOutputPiece(pieces: SentinelPiece[], data: string): void {
  if (data.length > 0) {
    pieces.push({ type: 'output', data });
  }
}

export function buildRunCompleteSentinel(marker: string): string {
  assertNonEmptyString(marker, 'marker');

  return `${RUN_COMPLETE_SENTINEL_PREFIX}${marker}${RUN_COMPLETE_SENTINEL_SUFFIX}`;
}

export class RunCompletionSentinelScanner {
  readonly #activeSentinels = new Map<string, ActiveSentinel>();
  #nextOrder = 0;
  #pendingTail = '';

  /**
   * Registers a marker as active. Re-registering an already-active marker is a
   * no-op; after the marker completes and deactivates, a later register() call
   * activates it again for a future run.
   */
  public register(marker: string): void {
    assertNonEmptyString(marker, 'marker');

    if (this.#activeSentinels.has(marker)) {
      return;
    }

    this.#activeSentinels.set(marker, {
      marker,
      sentinel: buildRunCompleteSentinel(marker),
      order: this.#nextOrder,
    });
    this.#nextOrder += 1;
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

      const candidates = this.#sortedActiveSentinels();
      const completeMatches = candidates.filter(({ sentinel }) =>
        buffer.startsWith(sentinel, index),
      );

      if (completeMatches.length > 0) {
        const matched = completeMatches[0];
        invariant(matched !== undefined, 'complete match must exist');

        if (
          !isFinal &&
          this.#hasLongerPossibleMatch(candidates, matched, buffer, index)
        ) {
          pushOutputPiece(pieces, buffer.slice(outputStart, index));
          this.#setPendingTail(buffer.slice(index));
          return pieces;
        }

        pushOutputPiece(pieces, buffer.slice(outputStart, index));
        pieces.push({ type: 'run_complete', marker: matched.marker });

        const deleted = this.#activeSentinels.delete(matched.marker);
        invariant(deleted, 'matched run-completion marker must be active');

        index += matched.sentinel.length;
        outputStart = index;
        continue;
      }

      const remaining = buffer.slice(index);
      const hasPartialMatch =
        !isFinal &&
        candidates.some(
          ({ sentinel }) =>
            remaining.length < sentinel.length &&
            sentinel.startsWith(remaining),
        );

      if (hasPartialMatch) {
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

  #hasLongerPossibleMatch(
    candidates: ActiveSentinel[],
    matched: ActiveSentinel,
    buffer: string,
    index: number,
  ): boolean {
    const remaining = buffer.slice(index);

    return candidates.some(
      ({ sentinel }) =>
        sentinel.length > matched.sentinel.length &&
        remaining.length < sentinel.length &&
        sentinel.startsWith(remaining),
    );
  }

  #sortedActiveSentinels(): ActiveSentinel[] {
    return [...this.#activeSentinels.values()].sort((left, right) => {
      const lengthDiff = right.sentinel.length - left.sentinel.length;
      if (lengthDiff !== 0) {
        return lengthDiff;
      }
      return left.order - right.order;
    });
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
