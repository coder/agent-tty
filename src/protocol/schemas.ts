import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const IsoDatetimeSchema = z.iso.datetime();
const SnapshotFormatSchema = z.enum(['structured', 'text']);

export const SessionStatusSchema = z.enum(['running', 'exiting', 'exited']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionRecordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string(),
    createdAt: IsoDatetimeSchema,
    updatedAt: IsoDatetimeSchema,
    status: SessionStatusSchema,
    command: z.array(z.string()).min(1),
    cwd: z.string(),
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
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
export type InputPasteEventPayload = z.infer<typeof InputPasteEventPayloadSchema>;

export const InputKeysEventPayloadSchema = z
  .object({
    keys: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();
export type InputKeysEventPayload = z.infer<typeof InputKeysEventPayloadSchema>;

export const ResizeEventPayloadSchema = z
  .object({
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
  })
  .strict();
export type ResizeEventPayload = z.infer<typeof ResizeEventPayloadSchema>;

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
  'resize',
  'signal',
  'exit',
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

export const ResizeEventRecordSchema = z
  .object({
    ...EventRecordBaseShape,
    type: z.literal('resize'),
    payload: ResizeEventPayloadSchema,
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
  ResizeEventRecordSchema,
  SignalEventRecordSchema,
  ExitEventRecordSchema,
]);
export type EventRecord = z.infer<typeof EventRecordSchema>;

export const VisibleLineSchema = z
  .object({
    row: NonNegativeIntSchema,
    text: z.string(),
  })
  .strict();
export type VisibleLine = z.infer<typeof VisibleLineSchema>;

export const SnapshotParamsSchema = z
  .object({
    format: SnapshotFormatSchema.optional(),
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
    profile: NonEmptyStringSchema.optional(),
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
  })
  .strict();
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

export const WaitForRenderParamsSchema = z
  .object({
    text: NonEmptyStringSchema.optional(),
    regex: NonEmptyStringSchema.optional(),
    screenStableMs: PositiveIntSchema.optional(),
    timeoutMs: PositiveIntSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasText = value.text !== undefined;
    const hasRegex = value.regex !== undefined;
    const hasScreenStableMs = value.screenStableMs !== undefined;

    if (!hasText && !hasRegex && !hasScreenStableMs) {
      ctx.addIssue({
        code: 'custom',
        message:
          'At least one of text, regex, or screenStableMs must be provided.',
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

export const WaitForRenderResultSchema = z
  .object({
    matched: z.boolean(),
    timedOut: z.boolean(),
    matchedText: z.string().optional(),
    capturedAtSeq: NonNegativeIntSchema,
  })
  .strict();
export type WaitForRenderResult = z.infer<typeof WaitForRenderResultSchema>;
