import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const FiniteNumberSchema = z.number().finite();
const IsoTimestampSchema = z.iso.datetime();
const StringListSchema = z.array(NonEmptyStringSchema);
const NullablePathSchema = NonEmptyStringSchema.nullable();
const NullableStringSchema = NonEmptyStringSchema.nullable();

export const TrialStatusSchema = z.enum(['passed', 'failed', 'errored']);
export type TrialStatus = z.infer<typeof TrialStatusSchema>;

export const RunStartEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    lanes: StringListSchema,
    conditions: StringListSchema,
    totalTrials: PositiveIntSchema,
    totalInvocations: PositiveIntSchema,
    outputDir: NonEmptyStringSchema,
    startedAt: IsoTimestampSchema,
  })
  .strict();
export type RunStartEvent = z.infer<typeof RunStartEventSchema>;

export const LaneStartEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    lane: NonEmptyStringSchema,
    caseIds: StringListSchema,
    conditions: StringListSchema,
    concurrency: PositiveIntSchema,
    plannedItems: PositiveIntSchema,
    startedAt: IsoTimestampSchema,
  })
  .strict();
export type LaneStartEvent = z.infer<typeof LaneStartEventSchema>;

export const CaseStartEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    lane: NonEmptyStringSchema,
    caseId: NonEmptyStringSchema,
    condition: NonEmptyStringSchema,
    plannedTrials: PositiveIntSchema,
    startedAt: IsoTimestampSchema,
  })
  .strict();
export type CaseStartEvent = z.infer<typeof CaseStartEventSchema>;

export const TrialStartEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    lane: NonEmptyStringSchema,
    caseId: NonEmptyStringSchema,
    condition: NonEmptyStringSchema,
    trial: PositiveIntSchema,
    startedAt: IsoTimestampSchema,
    requestedOutputPath: NullablePathSchema,
    requestedArtifactPath: NullablePathSchema,
  })
  .strict();
export type TrialStartEvent = z.infer<typeof TrialStartEventSchema>;

export const TrialFinishEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    lane: NonEmptyStringSchema,
    caseId: NonEmptyStringSchema,
    condition: NonEmptyStringSchema,
    trial: PositiveIntSchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    durationMs: NonNegativeIntSchema,
    status: TrialStatusSchema,
    ok: z.boolean(),
    errorClass: NullableStringSchema,
    errorMessage: NullableStringSchema,
    score: FiniteNumberSchema.nullable(),
    transcriptPath: NullablePathSchema,
    stdoutPath: NullablePathSchema,
    stderrPath: NullablePathSchema,
    eventLogPath: NullablePathSchema,
    bundlePath: NullablePathSchema,
    artifactManifestPath: NullablePathSchema,
  })
  .strict();
export type TrialFinishEvent = z.infer<typeof TrialFinishEventSchema>;

export const CaseFinishEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    lane: NonEmptyStringSchema,
    caseId: NonEmptyStringSchema,
    condition: NonEmptyStringSchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    durationMs: NonNegativeIntSchema,
    passed: NonNegativeIntSchema,
    failed: NonNegativeIntSchema,
    errored: NonNegativeIntSchema,
    meanScore: FiniteNumberSchema.nullable(),
    artifactPath: NullablePathSchema,
    reportPath: NullablePathSchema,
  })
  .strict();
export type CaseFinishEvent = z.infer<typeof CaseFinishEventSchema>;

export const LaneFinishEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    lane: NonEmptyStringSchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    durationMs: NonNegativeIntSchema,
    total: NonNegativeIntSchema,
    passed: NonNegativeIntSchema,
    failed: NonNegativeIntSchema,
    errored: NonNegativeIntSchema,
  })
  .strict();
export type LaneFinishEvent = z.infer<typeof LaneFinishEventSchema>;

export const RunFinishLaneErrorSchema = z
  .object({
    lane: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
  })
  .strict();
export type RunFinishLaneError = z.infer<typeof RunFinishLaneErrorSchema>;

export const RunFinishEventSchema = z
  .object({
    runId: NonEmptyStringSchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    durationMs: NonNegativeIntSchema,
    total: NonNegativeIntSchema,
    passed: NonNegativeIntSchema,
    failed: NonNegativeIntSchema,
    errored: NonNegativeIntSchema,
    laneErrors: z.array(RunFinishLaneErrorSchema),
    runDir: NonEmptyStringSchema,
    reportJsonPath: NullablePathSchema,
    reportMarkdownPath: NullablePathSchema,
  })
  .strict();
export type RunFinishEvent = z.infer<typeof RunFinishEventSchema>;

export interface ReporterEventPayloads {
  runStart: RunStartEvent;
  laneStart: LaneStartEvent;
  caseStart: CaseStartEvent;
  trialStart: TrialStartEvent;
  trialFinish: TrialFinishEvent;
  caseFinish: CaseFinishEvent;
  laneFinish: LaneFinishEvent;
  runFinish: RunFinishEvent;
}

export type ReporterEventName = keyof ReporterEventPayloads;
export type ReporterHook<TEvent> = (event: TEvent) => Promise<void> | void;

export interface Reporter {
  name: string;
  onRunStart?: ReporterHook<RunStartEvent>;
  onLaneStart?: ReporterHook<LaneStartEvent>;
  onCaseStart?: ReporterHook<CaseStartEvent>;
  onTrialStart?: ReporterHook<TrialStartEvent>;
  onTrialFinish?: ReporterHook<TrialFinishEvent>;
  onCaseFinish?: ReporterHook<CaseFinishEvent>;
  onLaneFinish?: ReporterHook<LaneFinishEvent>;
  onRunFinish?: ReporterHook<RunFinishEvent>;
}

export const EVENT_SCHEMAS = {
  runStart: RunStartEventSchema,
  laneStart: LaneStartEventSchema,
  caseStart: CaseStartEventSchema,
  trialStart: TrialStartEventSchema,
  trialFinish: TrialFinishEventSchema,
  caseFinish: CaseFinishEventSchema,
  laneFinish: LaneFinishEventSchema,
  runFinish: RunFinishEventSchema,
} satisfies { [K in ReporterEventName]: z.ZodType<ReporterEventPayloads[K]> };
