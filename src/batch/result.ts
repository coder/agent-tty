import { z } from 'zod';

import type { BatchPlan, BatchStep } from './plan.js';

import { unreachable } from '../util/assert.js';

// `interrupted` is the in-flight step abandoned by a SIGINT/SIGTERM flush (its
// RPC is not awaited, so its outcome is unknown); `not-run` is a later step the
// executor never reached. Only the CLI signal handler produces `interrupted`.
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

// Shape a record for a Batch Step that never finalized (`not-run` or
// `interrupted`): no seq, zero duration, no observed outcome.
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
 * Build a partial BatchResult from the finalized records plus the plan: the
 * first unreached step (in flight when the signal arrived) is `interrupted`,
 * the rest `not-run`. Lets the signal handler flush without awaiting the RPC.
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
