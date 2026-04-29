import crypto from 'node:crypto';

import {
  assertRunMarker,
  buildRunCompleteSignalSentinel,
  RUN_MARKER_PATTERN,
  RunCompletionPostambleEchoSanitizer,
  RunCompletionSentinelScanner,
  type SentinelPiece,
} from './runCompletionSentinel.js';
import { invariant } from '../util/assert.js';

const RUN_COMPLETION_POSTAMBLE_ECHO_PREFIX = String.raw`printf '\033\137`;
const RUN_COMPLETION_SIGNAL_TOKEN_BYTES = 4;
const MAX_RUN_COMPLETION_POSTAMBLE_ECHO_LENGTH = 64;

interface ActiveRunCompletion {
  inputRunSeq: number;
  sentinel: string;
}

interface RunCompletionWaiter {
  reject: (error: unknown) => void;
  resolve: (result: RunCompletionWaitResult) => void;
}

/** Wait result delivered by the underlying run-completion observer. */
type RunCompletionWaitResult =
  | { kind: 'completed'; seq: number }
  | { kind: 'exited' };

/** Public waited-run wait result after applying the caller timeout. */
export type TimedRunCompletionWaitResult =
  | RunCompletionWaitResult
  | { kind: 'timeout' };

/** Appends replayable run-completion events in the host's serialized PTY ingestion queue. */
export interface RunCompletionEventAppender {
  appendOutput(data: string): Promise<void>;
  appendRunComplete(payload: {
    marker: string;
    inputRunSeq: number;
  }): Promise<number>;
}

/** Marker prepared before `input_run` is appended for a waited run. */
export interface PreparedWaitedRun {
  marker: string;
}

/** Registered completion state returned after `input_run` appends successfully. */
export interface RegisteredWaitedRunCompletion {
  postamble: string;
  sentinel: string;
  wait(timeoutMs: number): Promise<TimedRunCompletionWaitResult>;
}

function shellOctalEscapedBytes(value: string): string {
  invariant(typeof value === 'string', 'value must be a string');

  return [...Buffer.from(value, 'utf8')]
    .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
    .join('');
}

function generateRunCompleteSignalSentinel(): string {
  const token = crypto
    .randomBytes(RUN_COMPLETION_SIGNAL_TOKEN_BYTES)
    .toString('base64url');
  invariant(
    token.length === 6,
    'run-completion signal token must encode to six base64url characters',
  );

  return buildRunCompleteSignalSentinel(token);
}

function buildRunCompletePostamble(marker: string, sentinel: string): string {
  const markerMatch = RUN_MARKER_PATTERN.exec(marker);
  invariant(
    markerMatch !== null,
    'run marker must match expected format (__AT_MARKER_<32hex>__)',
  );
  invariant(
    typeof sentinel === 'string' && sentinel.length > 0,
    'sentinel must be non-empty',
  );

  const markerPayload = markerMatch[1];
  invariant(
    markerPayload !== undefined && markerPayload.length === 32,
    'run marker payload must be 32 lowercase hex characters',
  );

  const postamble = `printf '${shellOctalEscapedBytes(sentinel)}'`;
  invariant(
    postamble.length <= MAX_RUN_COMPLETION_POSTAMBLE_ECHO_LENGTH,
    'run-completion postamble echo must stay short enough to avoid terminal wrapping',
  );
  invariant(
    postamble.startsWith(RUN_COMPLETION_POSTAMBLE_ECHO_PREFIX),
    'run-completion postamble echo prefix must stay in sync with sanitizer',
  );
  invariant(
    !postamble.includes('agent-tty:run-complete:'),
    'run-completion postamble must not echo the complete sentinel label',
  );
  invariant(
    !postamble.includes('__AT_MARKER_'),
    'run-completion postamble must not echo the complete marker prefix',
  );
  invariant(
    !postamble.includes(markerPayload),
    'run-completion postamble must not echo the complete marker payload',
  );

  return `${postamble}\n`;
}

/**
 * Coordinates waited-run completion markers, hidden sentinels, waiters, and
 * `run_complete` appends for a single host.
 *
 * `ingestPtyData()` and `flushPtyDataOnExit()` must be called serially by the
 * host's PTY ingestion queue. Concurrent ingestion would break event-log order
 * and can race scanner/sanitizer state.
 */
export class RunCompletionCoordinator {
  readonly #appender: RunCompletionEventAppender;
  #sentinelScanner = new RunCompletionSentinelScanner();
  #postambleEchoSanitizer = new RunCompletionPostambleEchoSanitizer();
  readonly #activeRunCompletions = new Map<string, ActiveRunCompletion>();
  readonly #runCompletionWaiters = new Map<string, RunCompletionWaiter>();

  public constructor(appender: RunCompletionEventAppender) {
    invariant(
      typeof appender.appendOutput === 'function',
      'run-completion output appender must be a function',
    );
    invariant(
      typeof appender.appendRunComplete === 'function',
      'run-completion completion appender must be a function',
    );

    this.#appender = appender;
  }

  /** Creates the marker that will be recorded on the pending `input_run`. */
  public prepareWaitedRun(): PreparedWaitedRun {
    const marker = `__AT_MARKER_${crypto.randomUUID().replace(/-/g, '')}__`;
    invariant(
      RUN_MARKER_PATTERN.test(marker),
      'generated run marker must match expected format (__AT_MARKER_<32hex>__)',
    );

    return { marker };
  }

  /**
   * Registers the marker after `input_run` appends and returns the shell
   * postamble to write. The returned `wait()` function is single-use.
   */
  public registerWaitedRun(params: {
    inputRunSeq: number;
    marker: string;
  }): RegisteredWaitedRunCompletion {
    const { inputRunSeq, marker } = params;
    assertRunMarker(marker);
    invariant(
      Number.isInteger(inputRunSeq) && inputRunSeq >= 0,
      'inputRunSeq must be a non-negative integer',
    );
    invariant(
      !this.#activeRunCompletions.has(marker),
      'generated run marker must be unique among active completions',
    );

    let sentinel = generateRunCompleteSignalSentinel();
    while (this.#hasActiveSentinel(sentinel)) {
      sentinel = generateRunCompleteSignalSentinel();
    }

    const postamble = buildRunCompletePostamble(marker, sentinel);
    this.#activeRunCompletions.set(marker, { inputRunSeq, sentinel });
    this.#sentinelScanner.register(marker, sentinel);
    this.#postambleEchoSanitizer.register(marker, postamble);
    const completionPromise = this.#subscribeRunCompletion(marker);
    let waitStarted = false;

    return {
      postamble,
      sentinel,
      wait: (timeoutMs: number): Promise<TimedRunCompletionWaitResult> => {
        invariant(
          !waitStarted,
          'run completion wait must only be started once',
        );
        waitStarted = true;
        return this.#waitForRunCompletion(marker, completionPromise, timeoutMs);
      },
    };
  }

  /** Ingests one PTY output chunk; callers must serialize calls. */
  public async ingestPtyData(data: string): Promise<void> {
    invariant(typeof data === 'string', 'PTY data must be a string');

    await this.#appendSentinelPieces(this.#sentinelScanner.feed(data));
  }

  /** Flushes scanner/sanitizer tails on PTY exit; callers must serialize calls. */
  public async flushPtyDataOnExit(): Promise<void> {
    await this.#appendSentinelPieces(this.#sentinelScanner.flush());
    await this.#appendFlushedPostambleEchoOutput();
  }

  /** Resolves pending waiters as exited and clears no-longer-observable state. */
  public resetForExit(): void {
    const waiters = [...this.#runCompletionWaiters.values()];
    this.#runCompletionWaiters.clear();
    this.#activeRunCompletions.clear();
    this.#sentinelScanner = new RunCompletionSentinelScanner();
    this.#postambleEchoSanitizer = new RunCompletionPostambleEchoSanitizer();

    for (const waiter of waiters) {
      waiter.resolve({ kind: 'exited' });
    }
  }

  #hasActiveSentinel(sentinel: string): boolean {
    invariant(
      typeof sentinel === 'string' && sentinel.length > 0,
      'sentinel must be non-empty',
    );

    return [...this.#activeRunCompletions.values()].some(
      (completion) => completion.sentinel === sentinel,
    );
  }

  #subscribeRunCompletion(marker: string): Promise<RunCompletionWaitResult> {
    assertRunMarker(marker);
    invariant(
      !this.#runCompletionWaiters.has(marker),
      'run completion waiter must be unique per marker',
    );

    const { promise, reject, resolve } =
      Promise.withResolvers<RunCompletionWaitResult>();
    this.#runCompletionWaiters.set(marker, { reject, resolve });
    return promise;
  }

  async #waitForRunCompletion(
    marker: string,
    completionPromise: Promise<RunCompletionWaitResult>,
    timeoutMs: number,
  ): Promise<TimedRunCompletionWaitResult> {
    assertRunMarker(marker);
    invariant(
      Number.isInteger(timeoutMs) && timeoutMs > 0,
      'timeoutMs must be positive',
    );

    const { promise, reject, resolve } =
      Promise.withResolvers<TimedRunCompletionWaitResult>();
    let resolved = false;
    const timeoutHandle = setTimeout(() => {
      if (resolved) {
        return;
      }

      resolved = true;
      // Keep sentinel/postamble registrations active after timeout so the
      // eventual internal completion bytes are still hidden from artifacts.
      this.#runCompletionWaiters.delete(marker);
      resolve({ kind: 'timeout' });
    }, timeoutMs);

    void completionPromise.then(
      (result) => {
        if (resolved) {
          return;
        }

        resolved = true;
        clearTimeout(timeoutHandle);
        resolve(result);
      },
      (error: unknown) => {
        if (resolved) {
          return;
        }

        resolved = true;
        clearTimeout(timeoutHandle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );

    return await promise;
  }

  async #appendOutput(data: string): Promise<void> {
    invariant(typeof data === 'string', 'output data must be a string');

    const outputData = this.#postambleEchoSanitizer.feed(data);
    if (outputData.length > 0) {
      await this.#appender.appendOutput(outputData);
    }
  }

  async #appendFlushedPostambleEchoOutput(): Promise<void> {
    const outputData = this.#postambleEchoSanitizer.flush();
    if (outputData.length > 0) {
      await this.#appender.appendOutput(outputData);
    }
  }

  async #appendSentinelPieces(pieces: SentinelPiece[]): Promise<void> {
    for (const piece of pieces) {
      if (piece.type === 'output') {
        await this.#appendOutput(piece.data);
        continue;
      }

      const activeCompletion = this.#activeRunCompletions.get(piece.marker);
      invariant(
        activeCompletion !== undefined,
        'run-completion sentinel must correspond to an active run marker',
      );
      invariant(
        activeCompletion.sentinel.length > 0,
        'active run-completion sentinel must be non-empty',
      );

      try {
        const trailingEchoOutput = this.#postambleEchoSanitizer.deregister(
          piece.marker,
        );
        if (trailingEchoOutput.length > 0) {
          await this.#appender.appendOutput(trailingEchoOutput);
        }

        const seq = await this.#appender.appendRunComplete({
          marker: piece.marker,
          inputRunSeq: activeCompletion.inputRunSeq,
        });
        invariant(
          Number.isInteger(seq) && seq >= 0,
          'run_complete append sequence must be a non-negative integer',
        );

        const deleted = this.#activeRunCompletions.delete(piece.marker);
        invariant(
          deleted,
          'active run completion must be deleted after append succeeds',
        );
        this.#resolveRunCompletionWaiter(piece.marker, seq);
      } catch (error) {
        this.#rejectRunCompletionWaiter(piece.marker, error);
        throw error;
      }
    }
  }

  #resolveRunCompletionWaiter(marker: string, seq: number): void {
    assertRunMarker(marker);
    invariant(
      Number.isInteger(seq) && seq >= 0,
      'run_complete sequence must be a non-negative integer',
    );

    const waiter = this.#runCompletionWaiters.get(marker);
    if (waiter === undefined) {
      return;
    }

    this.#runCompletionWaiters.delete(marker);
    waiter.resolve({ kind: 'completed', seq });
  }

  #rejectRunCompletionWaiter(marker: string, error: unknown): void {
    assertRunMarker(marker);
    const waiter = this.#runCompletionWaiters.get(marker);
    if (waiter === undefined) {
      return;
    }

    this.#runCompletionWaiters.delete(marker);
    waiter.reject(error);
  }
}
