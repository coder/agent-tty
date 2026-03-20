import { z } from 'zod';

import { SessionRecordSchema } from './schemas.js';

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

export const InspectResultSchema = z
  .object({
    session: SessionRecordSchema,
  })
  .strict();
export type InspectResult = z.infer<typeof InspectResultSchema>;

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

export const SendKeysParamsSchema = z
  .object({
    keys: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();
export type SendKeysParams = z.infer<typeof SendKeysParamsSchema>;

export const SendKeysResultSchema = EmptyObjectSchema;
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

export const WaitResultSchema = z
  .object({
    exitCode: z.number().int().optional(),
    timedOut: z.boolean(),
  })
  .strict();
export type WaitResult = z.infer<typeof WaitResultSchema>;

export const DestroyParamsSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();
export type DestroyParams = z.infer<typeof DestroyParamsSchema>;

export const DestroyResultSchema = EmptyObjectSchema;
export type DestroyResult = z.infer<typeof DestroyResultSchema>;

const RPC_METHODS = [
  'inspect',
  'type',
  'paste',
  'sendKeys',
  'resize',
  'signal',
  'wait',
  'destroy',
] as const;

export const RpcMethodSchema = z.enum(RPC_METHODS);
export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const RpcMethodSchemas = {
  inspect: {
    params: InspectParamsSchema,
    result: InspectResultSchema,
  },
  type: {
    params: TypeParamsSchema,
    result: TypeResultSchema,
  },
  paste: {
    params: PasteParamsSchema,
    result: PasteResultSchema,
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
