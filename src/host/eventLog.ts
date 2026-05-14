import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import {
  EventRecordSchema,
  InputRunEventPayloadSchema,
  MarkerEventPayloadSchema,
  RunCompleteEventPayloadSchema,
  type EventRecord,
  type InputRunEventPayload,
  type MarkerEventPayload,
  type RunCompleteEventPayload,
} from '../protocol/schemas.js';
import {
  assertEventLogSize,
  parseEventLogContent,
} from '../storage/eventLogCodec.js';
import { invariant } from '../util/assert.js';

const OutputEventPayloadSchema = z
  .object({
    data: z.string(),
  })
  .strict();

type OutputEventPayload = z.infer<typeof OutputEventPayloadSchema>;

const InputTextEventPayloadSchema = z
  .object({
    data: z.string(),
  })
  .strict();

type InputTextEventPayload = z.infer<typeof InputTextEventPayloadSchema>;

const InputPasteEventPayloadSchema = z
  .object({
    data: z.string(),
  })
  .strict();

type InputPasteEventPayload = z.infer<typeof InputPasteEventPayloadSchema>;

const InputKeysEventPayloadSchema = z
  .object({
    keys: z.array(z.string().min(1)).min(1),
  })
  .strict();

type InputKeysEventPayload = z.infer<typeof InputKeysEventPayloadSchema>;

const ResizeEventPayloadSchema = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();

type ResizeEventPayload = z.infer<typeof ResizeEventPayloadSchema>;

const SignalEventPayloadSchema = z
  .object({
    signal: z.string().min(1),
  })
  .strict();

type SignalEventPayload = z.infer<typeof SignalEventPayloadSchema>;

const ExitEventPayloadSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().nullable(),
  })
  .strict();

type ExitEventPayload = z.infer<typeof ExitEventPayloadSchema>;

type EventLogEventType =
  | 'output'
  | 'input_text'
  | 'input_paste'
  | 'input_keys'
  | 'input_run'
  | 'run_complete'
  | 'resize'
  | 'signal'
  | 'exit'
  | 'marker';
type EventLogPayload =
  | OutputEventPayload
  | InputTextEventPayload
  | InputPasteEventPayload
  | InputKeysEventPayload
  | InputRunEventPayload
  | RunCompleteEventPayload
  | ResizeEventPayload
  | SignalEventPayload
  | ExitEventPayload
  | MarkerEventPayload;

/**
 * Maximum number of events retained in the in-memory buffer.
 * At ~200 bytes per event object, 250k events ≈ 50MB — consistent with the file size limit.
 */
export const MAX_EVENT_BUFFER_ENTRIES = 250_000;

function assertFilePath(filePath: string): void {
  invariant(filePath.length > 0, 'filePath must be a non-empty string');
}

function validatePayload(
  type: EventLogEventType,
  payload: EventLogPayload,
): EventLogPayload {
  switch (type) {
    case 'output': {
      const result = OutputEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'output payload must match schema');
      return result.data;
    }
    case 'input_text': {
      const result = InputTextEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'input_text payload must match schema');
      return result.data;
    }
    case 'input_paste': {
      const result = InputPasteEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'input_paste payload must match schema');
      return result.data;
    }
    case 'input_keys': {
      const result = InputKeysEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'input_keys payload must match schema');
      return result.data;
    }
    case 'input_run': {
      const result = InputRunEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'input_run payload must match schema');
      return result.data;
    }
    case 'run_complete': {
      const result = RunCompleteEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'run_complete payload must match schema');
      return result.data;
    }
    case 'resize': {
      const result = ResizeEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'resize payload must match schema');
      return result.data;
    }
    case 'signal': {
      const result = SignalEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'signal payload must match schema');
      return result.data;
    }
    case 'exit': {
      const result = ExitEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'exit payload must match schema');
      return result.data;
    }
    case 'marker': {
      const result = MarkerEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'marker payload must match schema');
      return result.data;
    }
  }
}

function deriveNextSeq(records: readonly EventRecord[]): number {
  if (records.length === 0) {
    return 0;
  }

  const lastRecord = records.at(-1);
  invariant(lastRecord !== undefined, 'event log must contain a last record');
  invariant(lastRecord.seq >= 0, 'event log seq must be non-negative');

  return lastRecord.seq + 1;
}

/**
 * Returns the event log file size in bytes, or `undefined` when the file
 * does not exist (ENOENT). Non-ENOENT errors propagate to the caller.
 */
export async function statEventLogBytes(
  filePath: string,
): Promise<number | undefined> {
  assertFilePath(filePath);

  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }

    throw error;
  }
}

export async function countEventLogEntries(filePath: string): Promise<number> {
  assertFilePath(filePath);

  let count = 0;

  try {
    const lineReader = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of lineReader) {
      if (line.trim().length > 0) {
        count += 1;
      }
    }
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return 0;
    }

    throw error;
  }

  return count;
}

export class EventLog {
  // The writeQueue is intentionally poisoned on rejection. Once any append
  // fails, every subsequent queued write inherits that rejection so that
  // downstream code observes the failure and the event log remains the
  // canonical execution truth without sequence gaps. Do not refactor this
  // into a generic per-key serializer that recovers between operations.
  private writeQueue: Promise<void> = Promise.resolve();

  private eventBuffer: EventRecord[] = [];

  private constructor(
    filePath: string,
    private readonly fileHandle: FileHandle,
    private nextSeq: number,
    eventBuffer: EventRecord[] = [],
    private isClosed = false,
  ) {
    invariant(filePath.length > 0, 'filePath must be a non-empty string');
    invariant(Number.isInteger(nextSeq), 'nextSeq must be an integer');
    invariant(nextSeq >= 0, 'nextSeq must be non-negative');
    invariant(
      nextSeq === eventBuffer.length,
      'nextSeq must match buffered event count',
    );
    this.eventBuffer = eventBuffer;
  }

  static async open(filePath: string): Promise<EventLog> {
    assertFilePath(filePath);

    const fileHandle = await open(filePath, 'a');
    try {
      const fileStats = await fileHandle.stat();
      assertEventLogSize(fileStats.size);

      let eventBuffer: EventRecord[] = [];
      let nextSeq = 0;
      if (fileStats.size > 0) {
        const existingContent = await readFile(filePath, 'utf8');
        eventBuffer = parseEventLogContent(existingContent);
        nextSeq = deriveNextSeq(eventBuffer);
        invariant(nextSeq >= 0, 'derived next seq must be non-negative');
      }

      return new EventLog(filePath, fileHandle, nextSeq, eventBuffer);
    } catch (error) {
      await fileHandle.close();
      throw error;
    }
  }

  async append(type: 'output', payload: OutputEventPayload): Promise<number>;
  async append(
    type: 'input_text',
    payload: InputTextEventPayload,
  ): Promise<number>;
  async append(
    type: 'input_paste',
    payload: InputPasteEventPayload,
  ): Promise<number>;
  async append(
    type: 'input_keys',
    payload: InputKeysEventPayload,
  ): Promise<number>;
  async append(
    type: 'input_run',
    payload: InputRunEventPayload,
  ): Promise<number>;
  async append(
    type: 'run_complete',
    payload: RunCompleteEventPayload,
  ): Promise<number>;
  async append(type: 'resize', payload: ResizeEventPayload): Promise<number>;
  async append(type: 'signal', payload: SignalEventPayload): Promise<number>;
  async append(type: 'exit', payload: ExitEventPayload): Promise<number>;
  async append(type: 'marker', payload: MarkerEventPayload): Promise<number>;
  async append(
    type: EventLogEventType,
    payload: EventLogPayload,
  ): Promise<number> {
    invariant(!this.isClosed, 'cannot append to a closed event log');

    const validatedPayload = validatePayload(type, payload);
    const seq = this.nextSeq;
    invariant(
      seq === this.nextSeq,
      'event seq must match the expected next seq',
    );
    invariant(seq >= 0, 'event seq must be non-negative');
    this.nextSeq += 1;

    const record = {
      seq,
      ts: new Date().toISOString(),
      type,
      payload: validatedPayload,
    };

    invariant(
      record.seq === seq,
      'event record seq must match the reserved seq',
    );

    const parsedRecord = EventRecordSchema.safeParse(record);
    invariant(
      parsedRecord.success,
      'event record must match EventRecordSchema',
    );
    if (this.eventBuffer.length >= MAX_EVENT_BUFFER_ENTRIES) {
      this.nextSeq = seq;
    }
    invariant(
      this.eventBuffer.length < MAX_EVENT_BUFFER_ENTRIES,
      `event buffer exceeds ${String(MAX_EVENT_BUFFER_ENTRIES)} entries; session event log is too large`,
    );
    invariant(
      parsedRecord.data.seq === this.eventBuffer.length,
      'event record seq must match the buffered event count',
    );
    this.eventBuffer.push(parsedRecord.data);

    const line = `${JSON.stringify(parsedRecord.data)}\n`;
    const writePromise = this.writeQueue.then(async () => {
      try {
        await this.fileHandle.appendFile(line, 'utf8');
      } catch (error) {
        this.rollbackBufferedEventsFrom(seq);
        throw error;
      }
    });
    this.writeQueue = writePromise;

    try {
      await writePromise;
    } catch (error) {
      this.rollbackBufferedEventsFrom(seq);
      throw error;
    }

    return seq;
  }

  private rollbackBufferedEventsFrom(failedSeq: number): void {
    invariant(Number.isInteger(failedSeq), 'failedSeq must be an integer');
    invariant(failedSeq >= 0, 'failedSeq must be non-negative');

    if (this.eventBuffer.length <= failedSeq) {
      return;
    }

    const failedRecord = this.eventBuffer[failedSeq];
    invariant(failedRecord !== undefined, 'failed event record must exist');
    invariant(
      failedRecord.seq === failedSeq,
      'failed event seq must match the buffered rollback position',
    );

    this.eventBuffer.splice(failedSeq);
    this.nextSeq = this.eventBuffer.length;
  }

  getEvents(): readonly EventRecord[] {
    return this.eventBuffer;
  }

  getEventsSince(afterSeq: number): EventRecord[] {
    invariant(Number.isInteger(afterSeq), 'afterSeq must be an integer');
    invariant(afterSeq >= -1, 'afterSeq must be greater than or equal to -1');

    if (afterSeq >= this.eventBuffer.length) {
      return [];
    }

    return this.eventBuffer.slice(afterSeq + 1);
  }

  async readAll(): Promise<EventRecord[]> {
    await this.writeQueue;
    return this.eventBuffer.slice();
  }

  async close(): Promise<void> {
    invariant(!this.isClosed, 'event log is already closed');
    // Drain any in-flight append writes before closing the file.
    await this.writeQueue;
    await this.fileHandle.sync();
    await this.fileHandle.close();
    this.isClosed = true;
  }
}
