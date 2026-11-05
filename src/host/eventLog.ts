import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import {
  EventRecordSchema,
  InputMouseEventPayloadSchema,
  InputRunEventPayloadSchema,
  MarkerEventPayloadSchema,
  RunCompleteEventPayloadSchema,
  type EventRecord,
  type InputMouseEventPayload,
  type InputRunEventPayload,
  type MarkerEventPayload,
  type RunCompleteEventPayload,
} from '../protocol/schemas.js';
import {
  assertEventLogSize,
  MAX_EVENT_LOG_SIZE,
  parseEventLogContent,
} from '../storage/eventLogCodec.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

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
  | 'input_mouse'
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
  | InputMouseEventPayload
  | InputRunEventPayload
  | RunCompleteEventPayload
  | ResizeEventPayload
  | SignalEventPayload
  | ExitEventPayload
  | MarkerEventPayload;

export interface StartedAppend {
  readonly seq: number;
  readonly written: Promise<number>;
}

/**
 * Maximum number of events retained in the in-memory buffer.
 * At ~200 bytes per event object, 250k events ≈ 50MB — consistent with the file size limit.
 */
export const MAX_EVENT_BUFFER_ENTRIES = 250_000;

/**
 * Room that ordinary records leave free at the end of the file. The stop
 * record and the `exit` record are written inside it, so the file never
 * passes its limit. Both records are far smaller than this.
 */
export const EVENT_LOG_TAIL_RESERVE_BYTES = 4096;

/** Start of the label of the marker that records why the log stopped. */
export const EVENT_LOG_LIMIT_LABEL_PREFIX =
  'agent-tty: event log limit reached';

export interface EventLogOptions {
  /**
   * Size limit of the file in bytes. Defaults to `MAX_EVENT_LOG_SIZE`, which
   * readers enforce, and cannot exceed it. Tests inject a small limit.
   */
  readonly maxBytes?: number;
}

interface PreparedRecord {
  readonly record: EventRecord;
  readonly line: string;
  readonly bytes: number;
}

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
    case 'input_mouse': {
      const result = InputMouseEventPayloadSchema.safeParse(payload);
      invariant(result.success, 'input_mouse payload must match schema');
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
    if (hasErrorCode(error, 'ENOENT')) {
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
    if (hasErrorCode(error, 'ENOENT')) {
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

  // Bytes of the file once every queued write has landed. A failed write does
  // not give its bytes back: the poisoned writeQueue rejects every later
  // append anyway.
  private fileBytes: number;

  // Set once the log has stopped taking records. See `queueAppend`.
  private stopped = false;

  private constructor(
    filePath: string,
    private readonly fileHandle: FileHandle,
    private nextSeq: number,
    fileBytes: number,
    private readonly maxBytes: number,
    eventBuffer: EventRecord[] = [],
    private isClosed = false,
  ) {
    invariant(filePath.length > 0, 'filePath must be a non-empty string');
    invariant(Number.isInteger(nextSeq), 'nextSeq must be an integer');
    invariant(nextSeq >= 0, 'nextSeq must be non-negative');
    invariant(
      Number.isInteger(fileBytes) && fileBytes >= 0,
      'fileBytes must be a non-negative integer',
    );
    invariant(
      Number.isInteger(maxBytes) &&
        maxBytes > EVENT_LOG_TAIL_RESERVE_BYTES &&
        maxBytes <= MAX_EVENT_LOG_SIZE,
      'maxBytes must leave room beyond the tail reserve and must not exceed MAX_EVENT_LOG_SIZE',
    );
    this.fileBytes = fileBytes;
    invariant(
      nextSeq === eventBuffer.length,
      'nextSeq must match buffered event count',
    );
    this.eventBuffer = eventBuffer;
  }

  static async open(
    filePath: string,
    options: EventLogOptions = {},
  ): Promise<EventLog> {
    assertFilePath(filePath);
    const maxBytes = options.maxBytes ?? MAX_EVENT_LOG_SIZE;

    const fileHandle = await open(filePath, 'a');
    try {
      // Defense in depth: even though the session directory is 0o700, lock the
      // event log itself to owner-only — it holds the full terminal byte stream
      // (output plus injected input, which can include secrets).
      await fileHandle.chmod(0o600);

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

      return new EventLog(
        filePath,
        fileHandle,
        nextSeq,
        fileStats.size,
        maxBytes,
        eventBuffer,
      );
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
    type: 'input_mouse',
    payload: InputMouseEventPayload,
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
    return await this.queueAppend(type, payload).written;
  }

  startAppend(type: 'input_run', payload: InputRunEventPayload): StartedAppend {
    return this.queueAppend(type, payload);
  }

  /**
   * Appends a record while the log has room, and otherwise stops the log:
   *
   * - Ordinary records may fill the file up to `maxBytes` minus
   *   `EVENT_LOG_TAIL_RESERVE_BYTES`.
   * - The first record that does not fit stops the log. The log appends one
   *   stop marker inside the reserve (see `recordStop`), and from then on it
   *   records nothing but the `exit` record, which also fits in the reserve.
   * - A stopped log raises no error. It acknowledges a record that it does
   *   not store with the `seq` of the last stored record, so input handlers,
   *   run completion and resize keep working, and the program keeps running.
   *   Its later output, input, resizes, signals and markers are absent from
   *   the log, and so from every snapshot, screenshot and export, which
   *   replay the log.
   *
   * `seq` values stay contiguous because a record that is not stored never
   * takes one.
   */
  private queueAppend(
    type: EventLogEventType,
    payload: EventLogPayload,
  ): StartedAppend {
    invariant(!this.isClosed, 'cannot append to a closed event log');

    const validatedPayload = validatePayload(type, payload);
    if (this.stopped && type !== 'exit') {
      // A runaway program keeps printing: do not build records to drop.
      return this.acknowledgeUnstored();
    }

    const prepared = this.prepareRecord(type, validatedPayload);
    if (this.hasRoomFor(type, prepared.bytes)) {
      return this.enqueue(prepared);
    }

    if (!this.stopped) {
      this.recordStop();
    }
    return this.acknowledgeUnstored();
  }

  private prepareRecord(
    type: EventLogEventType,
    validatedPayload: EventLogPayload,
  ): PreparedRecord {
    const seq = this.nextSeq;
    invariant(seq >= 0, 'event seq must be non-negative');

    const parsedRecord = EventRecordSchema.safeParse({
      seq,
      ts: new Date().toISOString(),
      type,
      payload: validatedPayload,
    });
    invariant(
      parsedRecord.success,
      'event record must match EventRecordSchema',
    );

    const line = `${JSON.stringify(parsedRecord.data)}\n`;
    return {
      record: parsedRecord.data,
      line,
      bytes: Buffer.byteLength(line, 'utf8'),
    };
  }

  private hasRoomFor(type: EventLogEventType, bytes: number): boolean {
    const room = this.maxBytes - this.fileBytes;
    if (type === 'exit') {
      // The last record of a session may use the reserve.
      return bytes <= room;
    }

    return bytes <= room - EVENT_LOG_TAIL_RESERVE_BYTES;
  }

  /**
   * Stops the log and records why, once. The marker is the only existing
   * event type that fits: it carries a label, replayers ignore it, and the
   * asciicast export shows it as a marker. It goes into the reserve, so it
   * fits unless a log that this host did not write already filled the
   * reserve before it opened.
   */
  private recordStop(): void {
    this.stopped = true;

    const stop = this.prepareRecord('marker', {
      label: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(this.maxBytes)} bytes); later events are not recorded`,
    });
    if (stop.bytes > this.maxBytes - this.fileBytes) {
      return;
    }

    // A failed write reaches the caller through the poisoned writeQueue.
    this.enqueue(stop).written.catch(() => undefined);
  }

  private acknowledgeUnstored(): StartedAppend {
    const seq = this.nextSeq - 1;
    invariant(
      seq >= 0,
      'a log that does not store a record must hold an earlier record',
    );

    // Chained on the writeQueue so that the caller sees an earlier failed
    // write, and so that the seq is durable once this settles.
    return { seq, written: this.writeQueue.then(() => seq) };
  }

  private enqueue({ record, line, bytes }: PreparedRecord): StartedAppend {
    const seq = record.seq;
    invariant(
      seq === this.nextSeq,
      'event seq must match the expected next seq',
    );
    invariant(
      this.eventBuffer.length < MAX_EVENT_BUFFER_ENTRIES,
      `event buffer exceeds ${String(MAX_EVENT_BUFFER_ENTRIES)} entries; session event log is too large`,
    );
    invariant(
      seq === this.eventBuffer.length,
      'event record seq must match the buffered event count',
    );
    invariant(
      this.fileBytes + bytes <= this.maxBytes,
      'event log append must stay inside the size limit',
    );
    this.nextSeq += 1;
    this.eventBuffer.push(record);
    this.fileBytes += bytes;

    const writePromise = this.writeQueue.then(async () => {
      try {
        await this.fileHandle.appendFile(line, 'utf8');
      } catch (error) {
        this.rollbackBufferedEventsFrom(seq);
        throw error;
      }
    });
    this.writeQueue = writePromise;

    const written = writePromise.then(
      () => seq,
      (error: unknown) => {
        this.rollbackBufferedEventsFrom(seq);
        throw error;
      },
    );
    return { seq, written };
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
