import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const NonNegativeIntSchema = z.number().int().nonnegative();
const FiniteNumberSchema = z.number().finite();
const Sha256HexSchema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/u,
    'caseFingerprint must be a lowercase SHA-256 hex string',
  );
const SnapshotLaneSchema = z.enum(['prompt', 'execution', 'dogfood']);
const SnapshotConditionSchema = z.enum([
  'none',
  'self-load',
  'preloaded',
  'stale',
]);

export const SnapshotCheckOutcomeSchema = z.enum([
  'new',
  'orphaned',
  'unchanged',
  'improved',
  'regressed',
]);
export type SnapshotCheckOutcome = z.infer<typeof SnapshotCheckOutcomeSchema>;

export const SnapshotCheckCaseSchema = z
  .object({
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    lane: SnapshotLaneSchema,
    caseId: NonEmptyStringSchema,
    condition: SnapshotConditionSchema,
    caseFingerprint: Sha256HexSchema,
    totalTokens: NonNegativeIntSchema,
    outcome: SnapshotCheckOutcomeSchema,
    currentTotalTokens: NonNegativeIntSchema.optional(),
    snapshotTotalTokens: NonNegativeIntSchema.optional(),
    deltaTokens: z.number().int().optional(),
    deltaPercent: FiniteNumberSchema.optional(),
  })
  .strict();
export type SnapshotCheckCase = z.infer<typeof SnapshotCheckCaseSchema>;

export const SnapshotCheckSummarySchema = z
  .object({
    total: NonNegativeIntSchema,
    new: NonNegativeIntSchema,
    orphaned: NonNegativeIntSchema,
    unchanged: NonNegativeIntSchema,
    improved: NonNegativeIntSchema,
    regressed: NonNegativeIntSchema,
  })
  .strict();
export type SnapshotCheckSummary = z.infer<typeof SnapshotCheckSummarySchema>;

export const SnapshotCheckReportSchema = z
  .object({
    regressionThresholdPercent: FiniteNumberSchema.nonnegative(),
    cases: z.array(SnapshotCheckCaseSchema),
    summary: SnapshotCheckSummarySchema,
  })
  .strict();
export type SnapshotCheckReport = z.infer<typeof SnapshotCheckReportSchema>;
