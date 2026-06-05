import type { BatchPlan, BatchStep } from './plan.js';
import type {
  BatchResult,
  BatchStepRecord,
  RunStepRecord,
  WaitStepRecord,
} from './result.js';
import type { StepDriver } from './stepDriver.js';

import { CliError } from '../cli/errors.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { unreachable } from '../util/assert.js';
import { unreachedStepRecord } from './result.js';

export interface ExecuteBatchOptions {
  plan: BatchPlan;
  driver: StepDriver;
  /** When true, attempt every step regardless of failures (best-effort). */
  keepGoing: boolean;
  /**
   * Re-check that the Command Target is still commandable. Invoked around each
   * Render Wait — before the wait, and again after a matched result — so a
   * Session that exits or becomes non-commandable mid-Batch fails the wait step
   * rather than racing a dead Session. A rejection must be a CliError; it is
   * classified against the wait step.
   */
  assertCommandable?: () => Promise<void>;
  /** Invoked once per step, after its record is finalized. */
  onStep?: (record: BatchStepRecord) => void;
}

function toBatchStepError(error: CliError): { code: string; message: string } {
  return { code: error.code, message: error.message };
}

/**
 * Reframe a thrown non-CliError (e.g. an AssertionError from a violated
 * invariant) as a synthesized INTERNAL_ERROR so the executor can record it
 * against the offending step instead of letting it escape and discard the
 * per-step BatchResult.
 */
function reframeAsInternalError(error: unknown, index: number): CliError {
  return makeCliError(ERROR_CODES.INTERNAL_ERROR, {
    message: `Batch step ${String(index)} failed with an unexpected error.`,
    details: {
      stepIndex: index,
      reason: error instanceof Error ? error.message : String(error),
    },
    cause: error,
  });
}

function classifyRunOutcome(run: {
  noWait: boolean;
  completed?: boolean;
  timedOut?: boolean;
}): RunStepRecord['runOutcome'] {
  if (run.noWait) {
    return 'started';
  }
  if (run.completed === true) {
    return 'completed';
  }
  if (run.timedOut === true) {
    return 'timedOut';
  }
  // A Waited Run that neither completed nor timed out was interrupted by
  // Session exit (the Run Completion can no longer arrive).
  return 'sessionExited';
}

/**
 * Run an ordered Batch through the injected StepDriver, threading the Wait
 * Baseline from each input step into the following Render Wait and accumulating
 * a per-step BatchResult.
 *
 * Pure over the driver: no fs, no rpc, no real PTY/renderer. Fail-fast by
 * default — a failed Batch Step stops the loop unless `keepGoing` is set, after
 * which the remaining steps are recorded `not-run`. A failed step never throws
 * out of the executor: even a thrown non-CliError is reframed and recorded.
 */
export async function executeBatch(
  opts: ExecuteBatchOptions,
): Promise<BatchResult> {
  const { plan, driver, keepGoing, assertCommandable, onStep } = opts;

  const steps: BatchStepRecord[] = [];
  const failedIndices: number[] = [];
  let completedCount = 0;
  let lastInputSeq: number | undefined;
  let stopped = false;

  const finalize = (record: BatchStepRecord): void => {
    steps.push(record);
    if (record.status === 'completed') {
      completedCount += 1;
    } else if (record.status === 'failed') {
      failedIndices.push(record.index);
    }
    onStep?.(record);
  };

  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (step === undefined) {
      continue;
    }

    if (stopped) {
      finalize(notRunRecord(step, index));
      continue;
    }

    const startedAt = Date.now();
    let record: BatchStepRecord;
    try {
      record = await runStep(
        step,
        index,
        driver,
        lastInputSeq,
        startedAt,
        assertCommandable,
      );
    } catch (error) {
      const cliError =
        error instanceof CliError
          ? error
          : reframeAsInternalError(error, index);
      record = failedRecord(step, index, Date.now() - startedAt, cliError);
    }

    // An input step that completed advances the Wait Baseline; a wait never
    // does (it observes the baseline, it does not produce one).
    if (record.status === 'completed' && record.kind !== 'wait') {
      lastInputSeq = record.seq;
    }

    finalize(record);

    if (record.status === 'failed' && !keepGoing) {
      stopped = true;
    }
  }

  return { steps, completedCount, failedIndices };
}

async function runStep(
  step: BatchStep,
  index: number,
  driver: StepDriver,
  lastInputSeq: number | undefined,
  startedAt: number,
  assertCommandable: (() => Promise<void>) | undefined,
): Promise<BatchStepRecord> {
  switch (step.kind) {
    case 'type': {
      const seq = await driver.type(step.text);
      return {
        index,
        durationMs: Date.now() - startedAt,
        kind: 'type',
        status: 'completed',
        seq,
      };
    }
    case 'paste': {
      const seq = await driver.paste(step.text);
      return {
        index,
        durationMs: Date.now() - startedAt,
        kind: 'paste',
        status: 'completed',
        seq,
      };
    }
    case 'sendKeys': {
      const seq = await driver.sendKeys(step.keys);
      return {
        index,
        durationMs: Date.now() - startedAt,
        kind: 'sendKeys',
        status: 'completed',
        seq,
      };
    }
    case 'run':
      return runRunStep(step, index, driver, startedAt);
    case 'wait':
      return runWaitStep(
        step,
        index,
        driver,
        lastInputSeq,
        startedAt,
        assertCommandable,
      );
    default:
      return unreachable(step, `batch step kind dispatch at index ${index}`);
  }
}

async function runRunStep(
  step: Extract<BatchStep, { kind: 'run' }>,
  index: number,
  driver: StepDriver,
  startedAt: number,
): Promise<RunStepRecord> {
  const result = await driver.run(step.command, step.noWait, step.timeoutMs);
  const runOutcome = classifyRunOutcome({
    noWait: step.noWait,
    ...(result.completed === undefined ? {} : { completed: result.completed }),
    ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
  });

  // A no-wait run completes once accepted; a Waited Run completes only when the
  // host observed its Run Completion. A Waited Run that timed out or was
  // interrupted by Session exit is a failed step.
  const failed = !step.noWait && result.completed !== true;
  const base: Omit<RunStepRecord, 'error'> = {
    index,
    durationMs: Date.now() - startedAt,
    kind: 'run',
    status: failed ? 'failed' : 'completed',
    seq: result.seq,
    noWait: step.noWait,
    ...(result.completed === undefined ? {} : { completed: result.completed }),
    ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
    runOutcome,
  };
  if (!failed) {
    return base;
  }
  const code =
    runOutcome === 'timedOut'
      ? ERROR_CODES.WAIT_TIMEOUT
      : ERROR_CODES.SESSION_NOT_RUNNING;
  return {
    ...base,
    error: toBatchStepError(
      makeCliError(code, {
        message:
          runOutcome === 'timedOut'
            ? `Waited Run at step ${String(index)} timed out before completing.`
            : `Waited Run at step ${String(index)} was interrupted by Session exit before completing.`,
      }),
    ),
  };
}

async function runWaitStep(
  step: Extract<BatchStep, { kind: 'wait' }>,
  index: number,
  driver: StepDriver,
  lastInputSeq: number | undefined,
  startedAt: number,
  assertCommandable: (() => Promise<void>) | undefined,
): Promise<WaitStepRecord> {
  // A wait can match the screen of a Session that exited mid-Batch; gate the
  // wait on commandability before it runs (and again after a match) so a dead
  // Session is a failed wait step rather than a stale match.
  await assertCommandable?.();

  const result = await driver.wait(
    step.condition,
    lastInputSeq,
    step.timeoutMs,
  );

  const baseline =
    lastInputSeq === undefined ? {} : { waitBaseline: lastInputSeq };
  const matchedText =
    result.matchedText === undefined ? {} : { matchedText: result.matchedText };
  const observations = {
    matched: result.matched,
    timedOut: result.timedOut,
    ...matchedText,
    capturedAtSeq: result.capturedAtSeq,
  };

  // A timed-out wait (equivalently an unmatched result) is not a thrown error
  // from the driver, so classify it here as a failed step with its own code.
  if (result.timedOut || !result.matched) {
    return {
      index,
      durationMs: Date.now() - startedAt,
      kind: 'wait',
      status: 'failed',
      ...baseline,
      ...observations,
      error: toBatchStepError(
        makeCliError(ERROR_CODES.WAIT_TIMEOUT, {
          message: `Render wait at step ${String(index)} timed out before its condition was met.`,
        }),
      ),
    };
  }

  await assertCommandable?.();

  return {
    index,
    durationMs: Date.now() - startedAt,
    kind: 'wait',
    status: 'completed',
    ...baseline,
    ...observations,
  };
}

function failedRecord(
  step: BatchStep,
  index: number,
  durationMs: number,
  error: CliError,
): BatchStepRecord {
  const base = { index, durationMs, status: 'failed' as const };
  const stepError = toBatchStepError(error);
  switch (step.kind) {
    case 'run':
      return { ...base, kind: 'run', noWait: step.noWait, error: stepError };
    case 'wait':
      return { ...base, kind: 'wait', error: stepError };
    case 'type':
    case 'paste':
    case 'sendKeys':
      return { ...base, kind: step.kind, error: stepError };
    default:
      return unreachable(step, `batch failed-step kind at index ${index}`);
  }
}

function notRunRecord(step: BatchStep, index: number): BatchStepRecord {
  return unreachedStepRecord(step, index, 'not-run');
}
