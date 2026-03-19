import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { z } from 'zod';

import {
  EventRecordSchema,
  type EventRecord,
} from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';

const OutputEventPayloadSchema = z
  .object({
    data: z.string(),
  })
  .strict();

type OutputEventPayload = z.infer<typeof OutputEventPayloadSchema>;

const ExitEventPayloadSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().nullable(),
  })
  .strict();

type ExitEventPayload = z.infer<typeof ExitEventPayloadSchema>;

type EventLogEventType = 'output' | 'exit';
type EventLogPayload = OutputEventPayload | ExitEventPayload;

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
    case 'exit': {
      const result = ExitEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'exit payload must match schema');
      return result.data;
    }
  }
}

function deriveNextSeq(content: string): number {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return 0;
  }

  const lastLine = lines.at(-1);
  invariant(lastLine !== undefined, 'event log must contain a last line');

  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(lastLine);
  } catch {
    invariant(false, 'last event log line must be valid JSON');
  }

  const parsedRecord = EventRecordSchema.safeParse(parsedLine);
  invariant(parsedRecord.success, 'last event log line must match EventRecordSchema');

  const { seq } = parsedRecord.data;
  invariant(Number.isInteger(seq), 'event log seq must be an integer');
  invariant(seq >= 0, 'event log seq must be non-negative');

  return seq + 1;
}

export class EventLog {
  private constructor(
    private readonly fileHandle: FileHandle,
    private nextSeq: number,
    private isClosed = false,
  ) {
    invariant(Number.isInteger(nextSeq), 'nextSeq must be an integer');
    invariant(nextSeq >= 0, 'nextSeq must be non-negative');
  }

  static async open(filePath: string): Promise<EventLog> {
    assertFilePath(filePath);

    const fileHandle = await open(filePath, 'a');
    const fileStats = await fileHandle.stat();

    let nextSeq = 0;
    if (fileStats.size > 0) {
      const existingContent = await readFile(filePath, 'utf8');
      nextSeq = deriveNextSeq(existingContent);
    }

    return new EventLog(fileHandle, nextSeq);
  }

  async append(type: 'output', payload: OutputEventPayload): Promise<void>;
  async append(type: 'exit', payload: ExitEventPayload): Promise<void>;
  async append(type: EventLogEventType, payload: EventLogPayload): Promise<void> {
    invariant(!this.isClosed, 'cannot append to a closed event log');

    const validatedPayload = validatePayload(type, payload);
    const record: EventRecord = {
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      type,
      payload: validatedPayload,
    };

    const parsedRecord = EventRecordSchema.safeParse(record);
    invariant(parsedRecord.success, 'event record must match EventRecordSchema');

    await this.fileHandle.appendFile(`${JSON.stringify(parsedRecord.data)}\n`, 'utf8');
    this.nextSeq += 1;
  }

  async close(): Promise<void> {
    invariant(!this.isClosed, 'event log is already closed');

    await this.fileHandle.sync();
    await this.fileHandle.close();
    this.isClosed = true;
  }
}
