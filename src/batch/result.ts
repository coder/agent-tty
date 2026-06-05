import { z } from 'zod';

import type { BatchPlan, BatchStep } from './plan.js';

import { unreachable } from '../util/assert.js';

/**
 * Per-step outcome in a Batch result.
 *
 * - `completed`: the Batch Step ran and succeeded.
 * - `failed`: the Batch Step ran but failed (a timed-out Render Wait, or an
 *   input action that errored — e.g. the Command Target is no longer
 *   commandable).
 * - `not-run`: a later Batch Step the executor never reached because an earlier
 *   step failed fast, or because the run was interrupted by a signal.
 * - `interrupted`: the in-flight Batch Step the executor was running when the
 *   process received SIGINT/SIGTERM. Its RPC is abandoned, not awaited, so its
 *   outcome is unknown; the executor never produces this status, only the CLI
 *   signal handler does when it flushes a partial result.
 */
export const StepStatusSchema = z.enum([
  'completed',
  'failed',
  'not-run',
  'interrupted',
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const BatchStepErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();
export type BatchStepError = z.infer<typeof BatchStepErrorSchema>;

const NonNegativeIntSchema = z.number().int().nonnegative();

/**
 * A `type`, `paste`, or `sendKeys` Batch Step. `seq` is the Event Log sequence
 * the input produced; it becomes the Wait Baseline for the next `wait` step.
 */
export const InputStepRecordSchema = z
  .object({
    index: NonNegativeIntSchema,
    durationMs: NonNegativeIntSchema,
    kind: z.enum(['type', 'paste', 'sendKeys']),
    status: StepStatusSchema,
    seq: NonNegativeIntSchema.optional(),
    error: BatchStepErrorSchema.optional(),
  })
  .strict();
export type InputStepRecord = z.infer<typeof InputStepRecordSchema>;

/**
 * A `run` Batch Step (a Waited Run unless `noWait`). `seq` is the Event Log
 * sequence of the injected run, used as the next Wait Baseline.
 */
export const RunStepRecordSchema = z
  .object({
    index: NonNegativeIntSchema,
    durationMs: NonNegativeIntSchema,
    kind: z.literal('run'),
    status: StepStatusSchema,
    seq: NonNegativeIntSchema.optional(),
    noWait: z.boolean(),
    completed: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    runOutcome: z
      .enum(['completed', 'timedOut', 'sessionExited', 'started'])
      .optional(),
    error: BatchStepErrorSchema.optional(),
  })
  .strict();
export type RunStepRecord = z.infer<typeof RunStepRecordSchema>;

/**
 * A `wait` Batch Step (a Render Wait). `waitBaseline` records the Event Log
 * sequence the wait was anchored to (the prior input step's seq, or undefined
 * for a leading wait).
 */
export const WaitStepRecordSchema = z
  .object({
    index: NonNegativeIntSchema,
    durationMs: NonNegativeIntSchema,
    kind: z.literal('wait'),
    status: StepStatusSchema,
    waitBaseline: NonNegativeIntSchema.optional(),
    matched: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    matchedText: z.string().optional(),
    capturedAtSeq: NonNegativeIntSchema.optional(),
    error: BatchStepErrorSchema.optional(),
  })
  .strict();
export type WaitStepRecord = z.infer<typeof WaitStepRecordSchema>;

export const BatchStepRecordSchema = z.discriminatedUnion('kind', [
  InputStepRecordSchema,
  RunStepRecordSchema,
  WaitStepRecordSchema,
]);
export type BatchStepRecord = z.infer<typeof BatchStepRecordSchema>;

export const BatchResultSchema = z
  .object({
    steps: z.array(BatchStepRecordSchema),
    completedCount: NonNegativeIntSchema,
    failedIndices: z.array(NonNegativeIntSchema),
  })
  .strict();
export type BatchResult = z.infer<typeof BatchResultSchema>;

/**
 * Shape a record for a Batch Step that never finalized — either one the
 * executor never reached (`not-run`) or the in-flight step abandoned by a
 * signal (`interrupted`). Carries no `seq`/`durationMs` work because the step
 * produced no observed outcome.
 */
export function unreachedStepRecord(
  step: BatchStep,
  index: number,
  status: 'not-run' | 'interrupted',
): BatchStepRecord {
  const base = { index, durationMs: 0, status };
  switch (step.kind) {
    case 'run':
      return { ...base, kind: 'run', noWait: step.noWait };
    case 'wait':
      return { ...base, kind: 'wait' };
    case 'type':
    case 'paste':
    case 'sendKeys':
      return { ...base, kind: step.kind };
    default:
      return unreachable(step, `batch unreached-step kind at index ${index}`);
  }
}

/**
 * Build a partial BatchResult from the records finalized so far plus the
 * original plan, synthesizing records for the steps that never finalized: the
 * first unreached step (the one in flight when the signal arrived) is recorded
 * `interrupted`, and every step after it `not-run`.
 *
 * Pure: no fs, no rpc. Used by the CLI signal handler to flush a complete,
 * schema-valid envelope without awaiting the in-flight RPC.
 */
export function buildPartialBatchResult(
  plan: BatchPlan,
  recorded: readonly BatchStepRecord[],
): BatchResult {
  const steps = [...recorded];
  for (let index = recorded.length; index < plan.steps.length; index += 1) {
    const step = plan.steps[index];
    if (step === undefined) {
      continue;
    }
    // The first unreached step was in flight when the signal arrived; the rest
    // were never started.
    const status = index === recorded.length ? 'interrupted' : 'not-run';
    steps.push(unreachedStepRecord(step, index, status));
  }

  return {
    steps,
    completedCount: steps.filter((record) => record.status === 'completed')
      .length,
    failedIndices: steps
      .filter((record) => record.status === 'failed')
      .map((record) => record.index),
  };
}
