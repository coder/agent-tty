import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();
const PositiveNumberSchema = z.number().positive();
const CursorStyleSchema = z.enum(['block', 'bar', 'underline']);
const ThemeSchema = z.enum(['dark', 'light']);
const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, 'must be a hex color like #1e1e2e');

const OutputReplayEventSchema = z
  .object({
    seq: NonNegativeIntegerSchema,
    ts: z.iso.datetime(),
    type: z.literal('output'),
    payload: z
      .object({
        data: z.string(),
      })
      .strict(),
  })
  .strict();

const InputTextReplayEventSchema = z
  .object({
    seq: NonNegativeIntegerSchema,
    ts: z.iso.datetime(),
    type: z.literal('input_text'),
    payload: z
      .object({
        data: z.string(),
      })
      .strict(),
  })
  .strict();

const InputPasteReplayEventSchema = z
  .object({
    seq: NonNegativeIntegerSchema,
    ts: z.iso.datetime(),
    type: z.literal('input_paste'),
    payload: z
      .object({
        data: z.string(),
      })
      .strict(),
  })
  .strict();

const InputKeysReplayEventSchema = z
  .object({
    seq: NonNegativeIntegerSchema,
    ts: z.iso.datetime(),
    type: z.literal('input_keys'),
    payload: z
      .object({
        keys: z.array(NonEmptyStringSchema).min(1),
      })
      .strict(),
  })
  .strict();

const ResizeReplayEventSchema = z
  .object({
    seq: NonNegativeIntegerSchema,
    ts: z.iso.datetime(),
    type: z.literal('resize'),
    payload: z
      .object({
        cols: PositiveIntegerSchema,
        rows: PositiveIntegerSchema,
      })
      .strict(),
  })
  .strict();

const SignalReplayEventSchema = z
  .object({
    seq: NonNegativeIntegerSchema,
    ts: z.iso.datetime(),
    type: z.literal('signal'),
    payload: z
      .object({
        signal: NonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();

const ExitReplayEventSchema = z
  .object({
    seq: NonNegativeIntegerSchema,
    ts: z.iso.datetime(),
    type: z.literal('exit'),
    payload: z
      .object({
        exitCode: z.number().int().nullable(),
        exitSignal: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const ReplayEventSchema = z.discriminatedUnion('type', [
  OutputReplayEventSchema,
  InputTextReplayEventSchema,
  InputPasteReplayEventSchema,
  InputKeysReplayEventSchema,
  ResizeReplayEventSchema,
  SignalReplayEventSchema,
  ExitReplayEventSchema,
]);
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;

export const ReplayInputSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    initialCols: PositiveIntegerSchema,
    initialRows: PositiveIntegerSchema,
    events: z.array(ReplayEventSchema),
    targetSeq: NonNegativeIntegerSchema,
  })
  .strict()
  .superRefine(({ events }, context) => {
    let previousSeq: number | undefined;

    for (const [index, event] of events.entries()) {
      if (previousSeq !== undefined && event.seq <= previousSeq) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'seq'],
          message: 'events must be ordered by strictly increasing seq values',
        });
      }

      previousSeq = event.seq;
    }
  });
export type ReplayInput = z.infer<typeof ReplayInputSchema>;

export const ReplayStateSchema = z
  .object({
    lastSeq: NonNegativeIntegerSchema,
    cols: PositiveIntegerSchema,
    rows: PositiveIntegerSchema,
    cursorRow: NonNegativeIntegerSchema,
    cursorCol: NonNegativeIntegerSchema,
  })
  .strict();
export type ReplayState = z.infer<typeof ReplayStateSchema>;

export const VisibleLineSchema = z
  .object({
    row: NonNegativeIntegerSchema,
    text: z.string(),
  })
  .strict();
export type VisibleLine = z.infer<typeof VisibleLineSchema>;

export const SemanticSnapshotSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntegerSchema,
    cols: PositiveIntegerSchema,
    rows: PositiveIntegerSchema,
    cursorRow: NonNegativeIntegerSchema,
    cursorCol: NonNegativeIntegerSchema,
    isAltScreen: z.boolean(),
    visibleLines: z.array(VisibleLineSchema),
  })
  .strict();
export type SemanticSnapshot = z.infer<typeof SemanticSnapshotSchema>;

export const TextSnapshotSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntegerSchema,
    cols: PositiveIntegerSchema,
    rows: PositiveIntegerSchema,
    cursorRow: NonNegativeIntegerSchema,
    cursorCol: NonNegativeIntegerSchema,
    text: z.string(),
  })
  .strict();
export type TextSnapshot = z.infer<typeof TextSnapshotSchema>;

export const ScreenshotResultSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntegerSchema,
    profileName: NonEmptyStringSchema,
    cols: PositiveIntegerSchema,
    rows: PositiveIntegerSchema,
    pngPath: NonEmptyStringSchema,
    pngSizeBytes: PositiveIntegerSchema,
  })
  .strict();
export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

export const RenderProfileConfigSchema = z
  .object({
    name: NonEmptyStringSchema,
    theme: ThemeSchema,
    fontFamily: NonEmptyStringSchema,
    fontSize: PositiveNumberSchema,
    cursorStyle: CursorStyleSchema,
    backgroundColor: HexColorSchema,
    foregroundColor: HexColorSchema,
  })
  .strict();
export type RenderProfileConfig = z.infer<typeof RenderProfileConfigSchema>;
