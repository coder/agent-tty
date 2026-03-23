import { z } from 'zod';

import {
  MarkerEventPayloadSchema,
  RichSnapshotLineSchema,
  VisibleLineSchema,
  type VisibleLine,
} from '../protocol/schemas.js';

const NonEmptyStringSchema = z.string().min(1);
const NonNegativeIntSchema = z.number().int().nonnegative();
const PositiveIntSchema = z.number().int().positive();
const PositiveNumberSchema = z.number().positive();
const CursorStyleSchema = z.enum(['block', 'bar', 'underline']);
const ThemeSchema = z.enum(['dark', 'light']);
const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, 'must be a hex color like #1e1e2e');
const Sha256HexSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/u,
    'must be a 64-character lowercase SHA-256 hex string',
  );

const OutputReplayEventSchema = z
  .object({
    seq: NonNegativeIntSchema,
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
    seq: NonNegativeIntSchema,
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
    seq: NonNegativeIntSchema,
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
    seq: NonNegativeIntSchema,
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
    seq: NonNegativeIntSchema,
    ts: z.iso.datetime(),
    type: z.literal('resize'),
    payload: z
      .object({
        cols: PositiveIntSchema,
        rows: PositiveIntSchema,
      })
      .strict(),
  })
  .strict();

const MarkerReplayEventSchema = z
  .object({
    seq: NonNegativeIntSchema,
    ts: z.iso.datetime(),
    type: z.literal('marker'),
    payload: MarkerEventPayloadSchema,
  })
  .strict();

const SignalReplayEventSchema = z
  .object({
    seq: NonNegativeIntSchema,
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
    seq: NonNegativeIntSchema,
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
  MarkerReplayEventSchema,
  SignalReplayEventSchema,
  ExitReplayEventSchema,
]);
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;

export const ReplayInputSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    initialCols: PositiveIntSchema,
    initialRows: PositiveIntSchema,
    events: z.array(ReplayEventSchema),
    targetSeq: NonNegativeIntSchema,
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
    lastSeq: NonNegativeIntSchema,
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    cursorRow: NonNegativeIntSchema,
    cursorCol: NonNegativeIntSchema,
  })
  .strict();
export type ReplayState = z.infer<typeof ReplayStateSchema>;

export { VisibleLineSchema };
export type { VisibleLine };

export const SemanticSnapshotSchema = z
  .object({
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
export type SemanticSnapshot = z.infer<typeof SemanticSnapshotSchema>;

export const TextSnapshotSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntSchema,
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    cursorRow: NonNegativeIntSchema,
    cursorCol: NonNegativeIntSchema,
    text: z.string(),
  })
  .strict();
export type TextSnapshot = z.infer<typeof TextSnapshotSchema>;

export const ScreenshotResultSchema = z
  .object({
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntSchema,
    profileName: NonEmptyStringSchema,
    cols: PositiveIntSchema,
    rows: PositiveIntSchema,
    artifactPath: NonEmptyStringSchema,
    pngSizeBytes: PositiveIntSchema,
    rendererBackend: z.string().optional(),
    pixelWidth: PositiveIntSchema.optional(),
    pixelHeight: PositiveIntSchema.optional(),
    sha256: Sha256HexSchema.optional(),
    renderProfileHash: Sha256HexSchema.optional(),
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
