import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { z } from 'zod';

import { EventRecordSchema, type EventRecord } from '../protocol/schemas.js';
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
  | 'resize'
  | 'signal'
  | 'exit';
type EventLogPayload =
  | OutputEventPayload
  | InputTextEventPayload
  | InputPasteEventPayload
  | InputKeysEventPayload
  | ResizeEventPayload
  | SignalEventPayload
  | ExitEventPayload;

// Keep this in sync with the replay loader's event-log size limit.
const MAX_EVENT_LOG_SIZE = 50 * 1024 * 1024;

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
  }
}

function parseEventLogLine(line: string, lineNumber: number): EventRecord {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(line) as unknown;
  } catch {
    invariant(false, `event log line ${String(lineNumber)} must be valid JSON`);
  }

  const parsedRecord = EventRecordSchema.safeParse(parsedLine);
  invariant(
    parsedRecord.success,
    `event log line ${String(lineNumber)} must match EventRecordSchema`,
  );

  return parsedRecord.data;
}

function assertContiguousSequence(records: EventRecord[]): void {
  if (records.length === 0) {
    return;
  }

  invariant(records[0]?.seq === 0, 'first event log seq must be 0');

  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];

    invariant(previous !== undefined, 'previous event record must exist');
    invariant(current !== undefined, 'current event record must exist');
    invariant(
      current.seq === previous.seq + 1,
      'event log seq values must increase by 1 without gaps',
    );
  }
}

function parseEventLogContent(content: string): EventRecord[] {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const records = lines.map((line, index) =>
    parseEventLogLine(line, index + 1),
  );
  assertContiguousSequence(records);
  return records;
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

export class EventLog {
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
    const fileStats = await fileHandle.stat();
    invariant(
      fileStats.size <= MAX_EVENT_LOG_SIZE,
      `event log file exceeds size limit (${String(fileStats.size)} bytes, max ${String(MAX_EVENT_LOG_SIZE)})`,
    );

    let eventBuffer: EventRecord[] = [];
    let nextSeq = 0;
    if (fileStats.size > 0) {
      const existingContent = await readFile(filePath, 'utf8');
      eventBuffer = parseEventLogContent(existingContent);
      nextSeq = deriveNextSeq(eventBuffer);
      invariant(nextSeq >= 0, 'derived next seq must be non-negative');
    }

    return new EventLog(filePath, fileHandle, nextSeq, eventBuffer);
  }

  async append(type: 'output', payload: OutputEventPayload): Promise<void>;
  async append(
    type: 'input_text',
    payload: InputTextEventPayload,
  ): Promise<void>;
  async append(
    type: 'input_paste',
    payload: InputPasteEventPayload,
  ): Promise<void>;
  async append(
    type: 'input_keys',
    payload: InputKeysEventPayload,
  ): Promise<void>;
  async append(type: 'resize', payload: ResizeEventPayload): Promise<void>;
  async append(type: 'signal', payload: SignalEventPayload): Promise<void>;
  async append(type: 'exit', payload: ExitEventPayload): Promise<void>;
  async append(
    type: EventLogEventType,
    payload: EventLogPayload,
  ): Promise<void> {
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
