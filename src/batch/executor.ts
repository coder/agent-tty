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
  keepGoing: boolean;
  // Re-check commandability around each Render Wait (rejecting with a CliError)
  // so a Session that dies mid-Batch fails the wait rather than racing it.
  assertCommandable?: () => Promise<void>;
  onStep?: (record: BatchStepRecord) => void;
}

function toBatchStepError(error: CliError): { code: string; message: string } {
  return { code: error.code, message: error.message };
}

// Reframe a thrown non-CliError as INTERNAL_ERROR so it is recorded against the
// step rather than escaping and discarding the per-step BatchResult.
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
 * Run an ordered Batch through the injected StepDriver, threading each input
 * step's Wait Baseline into the following Render Wait. Pure over the driver;
 * fail-fast unless `keepGoing`, after which later steps are recorded `not-run`.
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

    // A non-wait step that produced a seq advances the Wait Baseline, even a
    // failed Waited Run (it still injected its command), so a following wait
    // cannot stale-match the pre-run screen under --keep-going.
    if (record.kind !== 'wait' && record.seq !== undefined) {
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

  // Re-check after the match; if the Session died in that window, keep the
  // observations on the failed record rather than emitting a bare error.
  try {
    await assertCommandable?.();
  } catch (error) {
    if (error instanceof CliError) {
      return {
        index,
        durationMs: Date.now() - startedAt,
        kind: 'wait',
        status: 'failed',
        ...baseline,
        ...observations,
        error: toBatchStepError(error),
      };
    }
    throw error;
  }

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
