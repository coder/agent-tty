import { z } from 'zod';

import {
  MAX_WAIT_FOR_RENDER_REGEX_LENGTH,
  MAX_WAIT_FOR_RENDER_TEXT_LENGTH,
} from '../renderWait/limits.js';
import { RendererNameSchema } from '../renderer/names.js';

const NonEmptyStringSchema = z.string().min(1);
const TextMatchSchema = z.string().min(1).max(MAX_WAIT_FOR_RENDER_TEXT_LENGTH);
const RegexPatternSchema = z
  .string()
  .min(1)
  .max(MAX_WAIT_FOR_RENDER_REGEX_LENGTH);
const ProfileNameSchema = z.string().min(1).max(100);
const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const IsoDatetimeSchema = z.iso.datetime();
const SnapshotFormatSchema = z.enum(['structured', 'text']);

export const ReplayTimingModeSchema = z.enum([
  'recorded',
  'accelerated',
  'max-speed',
]);
export type ReplayTimingMode = z.infer<typeof ReplayTimingModeSchema>;
const SessionEnvSchema = z.record(NonEmptyStringSchema, z.string());
const Sha256HexSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/u,
    'must be a 64-character lowercase SHA-256 hex string',
  );

export const SessionStatusSchema = z.enum([
  'running',
  // Transitional state kept for reconcileSession()/recordExit() compatibility.
  'exiting',
  'exited',
  'failed',
  'destroying',
  'destroyed',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const FailureOriginSchema = z.enum([
  'host-death',
  'renderer-failure',
  'storage-corruption',
  'unknown',
]);
export type FailureOrigin = z.infer<typeof FailureOriginSchema>;

export const SessionRecordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string(),
    createdAt: IsoDatetimeSchema,
    updatedAt: IsoDatetimeSchema,
    status: SessionStatusSchema,
    failureReason: z.string().min(1).optional(),
    failureOrigin: FailureOriginSchema.optional(),
    command: z.array(z.string()).min(1),
    cwd: z.string(),
    name: NonEmptyStringSchema.optional(),
    env: SessionEnvSchema.optional(),
    shell: NonEmptyStringSchema.optional(),
    term: NonEmptyStringSchema.optional(),
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    creationCols: PositiveIntSchema.optional(),
    creationRows: PositiveIntSchema.optional(),
    idleTimeoutMs: NonNegativeIntSchema.optional(),
    hostPid: PositiveIntSchema.nullable(),
    childPid: PositiveIntSchema.nullable(),
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().nullable(),
  })
  .strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const OutputEventPayloadSchema = z
  .object({
    data: z.string(),
  })
  .strict();
export type OutputEventPayload = z.infer<typeof OutputEventPayloadSchema>;

export const InputTextEventPayloadSchema = z
  .object({
    data: z.string(),
  })
  .strict();
export type InputTextEventPayload = z.infer<typeof InputTextEventPayloadSchema>;

export const InputPasteEventPayloadSchema = z
  .object({
    data: z.string(),
  })
  .strict();
export type InputPasteEventPayload = z.infer<
  typeof InputPasteEventPayloadSchema
>;

export const InputKeysEventPayloadSchema = z
  .object({
    keys: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();
export type InputKeysEventPayload = z.infer<typeof InputKeysEventPayloadSchema>;

export const InputRunEventPayloadSchema = z
  .object({
    command: z.string().min(1),
    marker: z.string().optional(),
    noWait: z.boolean(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (!obj.noWait && obj.marker === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'marker is required when noWait is false',
        path: ['marker'],
      });
    }

    if (obj.noWait && obj.marker !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'marker must not be set when noWait is true',
        path: ['marker'],
      });
    }
  });
export type InputRunEventPayload = z.infer<typeof InputRunEventPayloadSchema>;

export const RunCompleteEventPayloadSchema = z
  .object({
    marker: z.string(),
    inputRunSeq: NonNegativeIntSchema.optional(),
  })
  .strict();
export type RunCompleteEventPayload = z.infer<
  typeof RunCompleteEventPayloadSchema
>;

export const ResizeEventPayloadSchema = z
  .object({
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
  })
  .strict();
export type ResizeEventPayload = z.infer<typeof ResizeEventPayloadSchema>;

// Marker labels may be empty strings per the asciicast marker spec.
// This intentionally differs from input validation patterns that use .min(1).
export const MarkerEventPayloadSchema = z
  .object({
    label: z.string(),
  })
  .strict();
export type MarkerEventPayload = z.infer<typeof MarkerEventPayloadSchema>;

export const SignalEventPayloadSchema = z
  .object({
    signal: NonEmptyStringSchema,
  })
  .strict();
export type SignalEventPayload = z.infer<typeof SignalEventPayloadSchema>;

export const ExitEventPayloadSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().nullable(),
  })
  .strict();
export type ExitEventPayload = z.infer<typeof ExitEventPayloadSchema>;

export const EventTypeSchema = z.enum([
  'output',
  'input_text',
  'input_paste',
  'input_keys',
  'input_run',
  'run_complete',
  'resize',
  'signal',
  'exit',
  'marker',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

const EventRecordBaseShape = {
  seq: NonNegativeIntSchema,
  ts: IsoDatetimeSchema,
} as const;

export const OutputEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('output'),
    payload: OutputEventPayloadSchema,
  })
  .strict();

export const InputTextEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('input_text'),
    payload: InputTextEventPayloadSchema,
  })
  .strict();

export const InputPasteEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('input_paste'),
    payload: InputPasteEventPayloadSchema,
  })
  .strict();

export const InputKeysEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('input_keys'),
    payload: InputKeysEventPayloadSchema,
  })
  .strict();

export const InputRunEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('input_run'),
    payload: InputRunEventPayloadSchema,
  })
  .strict();

export const RunCompleteEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('run_complete'),
    payload: RunCompleteEventPayloadSchema,
  })
  .strict();

export const ResizeEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('resize'),
    payload: ResizeEventPayloadSchema,
  })
  .strict();

export const MarkerEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('marker'),
    payload: MarkerEventPayloadSchema,
  })
  .strict();

export const SignalEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('signal'),
    payload: SignalEventPayloadSchema,
  })
  .strict();

export const ExitEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('exit'),
    payload: ExitEventPayloadSchema,
  })
  .strict();

export const EventRecordSchema = z.discriminatedUnion('type', [
  OutputEventRecordSchema,
  InputTextEventRecordSchema,
  InputPasteEventRecordSchema,
  InputKeysEventRecordSchema,
  InputRunEventRecordSchema,
  RunCompleteEventRecordSchema,
  ResizeEventRecordSchema,
  SignalEventRecordSchema,
  ExitEventRecordSchema,
  MarkerEventRecordSchema,
]);
export type EventRecord = z.infer<typeof EventRecordSchema>;

export const VisibleLineSchema = z
  .object({
    row: NonNegativeIntSchema,
    text: z.string(),
  })
  .strict();
export type VisibleLine = z.infer<typeof VisibleLineSchema>;

export const SnapshotCellSchema = z
  .object({
    char: z.string(),
    fg: z.string().optional(),
    bg: z.string().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
  })
  .strict();
export type SnapshotCell = z.infer<typeof SnapshotCellSchema>;

export const RichSnapshotLineSchema = z
  .object({
    lineNumber: z.number().int().nonnegative(),
    cells: z.array(SnapshotCellSchema),
  })
  .strict();
export type RichSnapshotLine = z.infer<typeof RichSnapshotLineSchema>;

export const SnapshotParamsSchema = z
  .object({
    format: SnapshotFormatSchema.optional(),
    includeScrollback: z.boolean().optional(),
    includeCells: z.boolean().optional(),
    rendererName: RendererNameSchema.optional(),
  })
  .strict();
export type SnapshotParams = z.infer<typeof SnapshotParamsSchema>;

export const StructuredSnapshotResultSchema = z
  .object({
    format: z.literal('structured'),
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntSchema,
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    cursorRow: NonNegativeIntSchema,
    cursorCol: NonNegativeIntSchema,
    isAltScreen: z.boolean(),
    visibleLines: z.array(VisibleLineSchema),
    scrollbackLines: z.array(VisibleLineSchema).optional(),
    cells: z.array(RichSnapshotLineSchema).optional(),
  })
  .strict();
export type StructuredSnapshotResult = z.infer<
  typeof StructuredSnapshotResultSchema
>;

export const TextSnapshotResultSchema = z
  .object({
    format: z.literal('text'),
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntSchema,
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    cursorRow: NonNegativeIntSchema,
    cursorCol: NonNegativeIntSchema,
    text: z.string(),
  })
  .strict();
export type TextSnapshotResult = z.infer<typeof TextSnapshotResultSchema>;

export const SnapshotResultSchema = z.discriminatedUnion('format', [
  StructuredSnapshotResultSchema,
  TextSnapshotResultSchema,
]);
export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;

export const ScreenshotParamsSchema = z
  .object({
    profile: ProfileNameSchema.optional(),
    showCursor: z.boolean().optional(),
    rendererName: RendererNameSchema.optional(),
  })
  .strict();
export type ScreenshotParams = z.infer<typeof ScreenshotParamsSchema>;

export const ScreenshotResultSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntSchema,
    profileName: NonEmptyStringSchema,
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    artifactPath: NonEmptyStringSchema,
    pngSizeBytes: PositiveIntSchema,
    cursorVisible: z.boolean().optional(),
    rendererBackend: z.string().optional(),
    pixelWidth: PositiveIntSchema.optional(),
    pixelHeight: PositiveIntSchema.optional(),
    sha256: Sha256HexSchema.optional(),
    renderProfileHash: Sha256HexSchema.optional(),
  })
  .strict();
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

export const WaitForRenderParamsSchema = z
  .object({
    text: TextMatchSchema.optional(),
    regex: RegexPatternSchema.optional(),
    screenStableMs: PositiveIntSchema.optional(),
    cursorRow: NonNegativeIntSchema.optional(),
    cursorCol: NonNegativeIntSchema.optional(),
    afterSeq: NonNegativeIntSchema.optional(),
    timeoutMs: PositiveIntSchema.optional(),
    rendererName: RendererNameSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasText = value.text !== undefined;
    const hasRegex = value.regex !== undefined;
    const hasScreenStableMs = value.screenStableMs !== undefined;
    const hasCursorRow = value.cursorRow !== undefined;
    const hasCursorCol = value.cursorCol !== undefined;

    if (
      !hasText &&
      !hasRegex &&
      !hasScreenStableMs &&
      !hasCursorRow &&
      !hasCursorCol
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'At least one of text, regex, screenStableMs, cursorRow, or cursorCol must be provided.',
      });
    }

    if (hasText && hasRegex) {
      ctx.addIssue({
        code: 'custom',
        message: 'text and regex are mutually exclusive.',
        path: ['regex'],
      });
    }
  });
export type WaitForRenderParams = z.infer<typeof WaitForRenderParamsSchema>;

export const WaitResultSchema = z
  .object({
    exitCode: z.number().int().optional(),
    timedOut: z.boolean(),
  })
  .strict();
export type WaitResult = z.infer<typeof WaitResultSchema>;

export const WaitForRenderResultSchema = z
  .object({
    matched: z.boolean(),
    timedOut: z.boolean(),
    matchedText: z.string().optional(),
    cursorRow: NonNegativeIntSchema.optional(),
    cursorCol: NonNegativeIntSchema.optional(),
    capturedAtSeq: NonNegativeIntSchema,
  })
  .strict();
export const RecordExportResultSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    format: z.enum(['asciicast', 'webm']),
    artifactPath: NonEmptyStringSchema,
    bytes: PositiveIntSchema,
    sha256: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntSchema,
    durationMs: NonNegativeIntSchema.optional(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RecordExportResult = z.infer<typeof RecordExportResultSchema>;

export type WaitForRenderResult = z.infer<typeof WaitForRenderResultSchema>;

// --- Week 8: Capability and renderer-runtime schemas ---
export {
  CapabilityEntrySchema,
  CapabilityNameSchema,
  CapabilityStatusSchema,
  RendererRuntimeModeSchema,
  RendererRuntimeStatusSchema,
  RendererRuntimeSummarySchema,
} from '../renderer/capabilities.js';

export type {
  CapabilityEntry,
  CapabilityName,
  CapabilityStatus,
  RendererRuntimeMode,
  RendererRuntimeStatus,
  RendererRuntimeSummary,
} from '../renderer/capabilities.js';
