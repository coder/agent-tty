import { z } from 'zod';

export const SessionStatusSchema = z.enum(['running', 'exiting', 'exited']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionRecordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    status: SessionStatusSchema,
    command: z.array(z.string()).min(1),
    cwd: z.string(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    hostPid: z.number().int().positive().nullable(),
    childPid: z.number().int().positive().nullable(),
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().nullable(),
  })
  .strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

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

export const EventRecordSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: z.iso.datetime(),
    type: EventTypeSchema,
    payload: z.unknown(),
  })
  .strict();
export type EventRecord = z.infer<typeof EventRecordSchema>;
