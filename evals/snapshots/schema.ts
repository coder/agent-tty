import { z } from 'zod';

import {
  EvalLaneSchema,
  EvalResultSchema,
  SkillConditionSchema,
  TokenUsageSchema,
} from '../lib/schemas.js';
import { invariant } from '../../src/util/assert.js';

const NonEmptyStringSchema = EvalResultSchema.shape.providerId;
const NonNegativeIntSchema = TokenUsageSchema.shape.totalTokens;
const Sha256HexSchema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/u,
    'caseFingerprint must be a lowercase SHA-256 hex string',
  );

const SnapshotLogicalKeySchema = z
  .object({
    lane: EvalLaneSchema,
    caseId: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    caseFingerprint: Sha256HexSchema,
  })
  .passthrough();

export const SnapshotEntrySchema = z
  .object({
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    lane: EvalLaneSchema,
    caseId: NonEmptyStringSchema,
    condition: SkillConditionSchema,
    caseFingerprint: Sha256HexSchema,
    inputTokens: TokenUsageSchema.shape.inputTokens,
    outputTokens: TokenUsageSchema.shape.outputTokens,
    totalTokens: TokenUsageSchema.shape.totalTokens,
    cachedTokens: TokenUsageSchema.shape.cachedTokens,
    createdAtMs: NonNegativeIntSchema,
  })
  .strict();

export type SnapshotEntry = z.infer<typeof SnapshotEntrySchema>;
export type SnapshotLogicalKeyFields = z.infer<typeof SnapshotLogicalKeySchema>;

export function buildSnapshotLogicalKey(
  fields: SnapshotLogicalKeyFields,
): string {
  const parsedFields = SnapshotLogicalKeySchema.safeParse(fields);
  if (!parsedFields.success) {
    invariant(
      false,
      `Invalid snapshot logical key fields: ${parsedFields.error.message}`,
    );
  }

  return JSON.stringify([
    parsedFields.data.lane,
    parsedFields.data.caseId,
    parsedFields.data.condition,
    parsedFields.data.caseFingerprint,
  ]);
}
