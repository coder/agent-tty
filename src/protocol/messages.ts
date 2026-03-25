import { z } from 'zod';

import type {
  RecordExportResult as RecordExportResultType,
  ReplayTimingMode as ReplayTimingModeType,
  RichSnapshotLine as RichSnapshotLineType,
  SnapshotCell as SnapshotCellType,
} from './schemas.js';

import {
  RendererRuntimeSummarySchema,
  ScreenshotParamsSchema,
  ScreenshotResultSchema,
  SessionRecordSchema,
  SnapshotParamsSchema,
  SnapshotResultSchema,
  WaitForRenderParamsSchema,
  WaitForRenderResultSchema,
  WaitResultSchema,
} from './schemas.js';

export {
  RecordExportResultSchema,
  ReplayTimingModeSchema,
  RichSnapshotLineSchema,
  ScreenshotParamsSchema,
  ScreenshotResultSchema,
  SnapshotCellSchema,
  SnapshotParamsSchema,
  SnapshotResultSchema,
  WaitForRenderParamsSchema,
  WaitForRenderResultSchema,
  WaitResultSchema,
} from './schemas.js';

// --- Week 8: Capability and renderer-runtime schemas ---
export {
  CapabilityEntrySchema,
  CapabilityNameSchema,
  CapabilityStatusSchema,
  RendererRuntimeModeSchema,
  RendererRuntimeStatusSchema,
  RendererRuntimeSummarySchema,
} from './schemas.js';

export type {
  CapabilityEntry,
  CapabilityName,
  CapabilityStatus,
  RendererRuntimeMode,
  RendererRuntimeStatus,
  RendererRuntimeSummary,
} from './schemas.js';

const EmptyObjectSchema = z.object({}).strict();
const NonEmptyStringSchema = z.string().min(1);
const DurationSchema = z.number().int().positive();

export const RpcRequestSchema = z
  .object({
    id: NonEmptyStringSchema,
    method: NonEmptyStringSchema,
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
  })
  .strict();
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcSuccessResponseSchema = z
  .object({
    id: NonEmptyStringSchema,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();
export type RpcSuccessResponse = z.infer<typeof RpcSuccessResponseSchema>;

export const RpcErrorResponseSchema = z
  .object({
    id: NonEmptyStringSchema,
    ok: z.literal(false),
    error: RpcErrorSchema,
  })
  .strict();
export type RpcErrorResponse = z.infer<typeof RpcErrorResponseSchema>;

export const RpcResponseSchema = z.discriminatedUnion('ok', [
  RpcSuccessResponseSchema,
  RpcErrorResponseSchema,
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export const InspectParamsSchema = EmptyObjectSchema;
export type InspectParams = z.infer<typeof InspectParamsSchema>;

export const HostInspectResultSchema = z
  .object({
    session: SessionRecordSchema,
  })
  .strict();
export type HostInspectResult = z.infer<typeof HostInspectResultSchema>;

export const TerminationCategorySchema = z.enum([
  'running',
  'clean-exit',
  'nonzero-exit',
  'signal-exit',
  'host-death',
  'renderer-failure',
  'storage-corruption',
  'destroyed',
  'unknown',
]);
export type TerminationCategory = z.infer<typeof TerminationCategorySchema>;

export const ArtifactHealthSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    missingCount: z.number().int().nonnegative(),
    health: z.enum([
      'healthy',
      'missing-artifacts',
      'manifest-invalid',
      'no-artifacts',
      'unknown',
    ]),
    missing: z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.string(),
            filename: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ArtifactHealthSummary = z.infer<typeof ArtifactHealthSummarySchema>;

export const InspectResultSchema = z
  .object({
    session: SessionRecordSchema,
    eventCount: z.number().int().nonnegative(),
    uptime: z.number().int().nonnegative(),
    lastEventSeq: z.number().int().nonnegative().optional(),
    terminationCategory: TerminationCategorySchema.optional(),
    artifacts: ArtifactHealthSummarySchema.optional(),
    usedOfflineReplay: z.boolean().optional(),
    rendererRuntime: RendererRuntimeSummarySchema.optional(),
  })
  .strict();
export type InspectResult = z.infer<typeof InspectResultSchema>;

export type ReplayTimingMode = ReplayTimingModeType;

export type SnapshotCell = SnapshotCellType;

export type RichSnapshotLine = RichSnapshotLineType;

export type SnapshotParams = z.infer<typeof SnapshotParamsSchema>;

export type SnapshotResult = z.infer<typeof SnapshotResultSchema>;

export type ScreenshotParams = z.infer<typeof ScreenshotParamsSchema>;

export type ScreenshotResult = z.infer<typeof ScreenshotResultSchema>;

export type RecordExportResult = RecordExportResultType;

export const TypeParamsSchema = z
  .object({
    text: z.string().min(1),
  })
  .strict();
export type TypeParams = z.infer<typeof TypeParamsSchema>;

export const TypeResultSchema = EmptyObjectSchema;
export type TypeResult = z.infer<typeof TypeResultSchema>;

export const PasteParamsSchema = z
  .object({
    text: z.string().min(1),
  })
  .strict();
export type PasteParams = z.infer<typeof PasteParamsSchema>;

export const PasteResultSchema = EmptyObjectSchema;
export type PasteResult = z.infer<typeof PasteResultSchema>;

export const MarkParamsSchema = z
  .object({
    label: z.string(),
  })
  .strict();
export type MarkParams = z.infer<typeof MarkParamsSchema>;

export const MarkResultSchema = z
  .object({
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type MarkResult = z.infer<typeof MarkResultSchema>;

export const SendKeysParamsSchema = z
  .object({
    keys: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();
export type SendKeysParams = z.infer<typeof SendKeysParamsSchema>;

export const SendKeysResultSchema = z
  .object({
    accepted: z.array(NonEmptyStringSchema).min(1),
    bytesWritten: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type SendKeysResult = z.infer<typeof SendKeysResultSchema>;

export const ResizeParamsSchema = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
export type ResizeParams = z.infer<typeof ResizeParamsSchema>;

export const ResizeResultSchema = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
export type ResizeResult = z.infer<typeof ResizeResultSchema>;

export const SignalParamsSchema = z
  .object({
    signal: NonEmptyStringSchema,
  })
  .strict();
export type SignalParams = z.infer<typeof SignalParamsSchema>;

export const SignalResultSchema = EmptyObjectSchema;
export type SignalResult = z.infer<typeof SignalResultSchema>;

export const WaitParamsSchema = z
  .object({
    exit: z.boolean().optional(),
    idleMs: DurationSchema.optional(),
    timeoutMs: DurationSchema.optional(),
  })
  .strict();
export type WaitParams = z.infer<typeof WaitParamsSchema>;

export type WaitResult = z.infer<typeof WaitResultSchema>;

export type WaitForRenderParams = z.infer<typeof WaitForRenderParamsSchema>;

export type WaitForRenderResult = z.infer<typeof WaitForRenderResultSchema>;

export const DestroyParamsSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();
export type DestroyParams = z.infer<typeof DestroyParamsSchema>;

export const DestroyResultSchema = z
  .object({
    sessionId: z.string().min(1),
    destroyed: z.boolean(),
  })
  .strict();
export type DestroyResult = z.infer<typeof DestroyResultSchema>;

const RPC_METHODS = [
  'inspect',
  'snapshot',
  'screenshot',
  'type',
  'paste',
  'mark',
  'sendKeys',
  'resize',
  'signal',
  'wait',
  'waitForRender',
  'destroy',
] as const;

export const RpcMethodSchema = z.enum(RPC_METHODS);
export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const RpcMethodSchemas = {
  inspect: {
    params: InspectParamsSchema,
    result: HostInspectResultSchema,
  },
  snapshot: {
    params: SnapshotParamsSchema,
    result: SnapshotResultSchema,
  },
  screenshot: {
    params: ScreenshotParamsSchema,
    result: ScreenshotResultSchema,
  },
  type: {
    params: TypeParamsSchema,
    result: TypeResultSchema,
  },
  paste: {
    params: PasteParamsSchema,
    result: PasteResultSchema,
  },
  mark: {
    params: MarkParamsSchema,
    result: MarkResultSchema,
  },
  sendKeys: {
    params: SendKeysParamsSchema,
    result: SendKeysResultSchema,
  },
  resize: {
    params: ResizeParamsSchema,
    result: ResizeResultSchema,
  },
  signal: {
    params: SignalParamsSchema,
    result: SignalResultSchema,
  },
  wait: {
    params: WaitParamsSchema,
    result: WaitResultSchema,
  },
  waitForRender: {
    params: WaitForRenderParamsSchema,
    result: WaitForRenderResultSchema,
  },
  destroy: {
    params: DestroyParamsSchema,
    result: DestroyResultSchema,
  },
} as const satisfies Record<
  RpcMethod,
  {
    params: z.ZodType;
    result: z.ZodType;
  }
>;
