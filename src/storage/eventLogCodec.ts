import { readFile, stat } from 'node:fs/promises';

import { EventRecordSchema, type EventRecord } from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';

export const MAX_EVENT_LOG_SIZE = 50 * 1024 * 1024;

/**
 * A log file larger than the limit. This is a state of the file, not a bug in
 * the caller, so commands can catch it and name the cause. The host writer
 * never produces such a file: it stops appending at the limit.
 */
export class EventLogTooLargeError extends Error {
  public readonly size: number;
  public readonly maxSize: number;

  public constructor(size: number, maxSize: number) {
    super(
      `event log file exceeds size limit (${String(size)} bytes, max ${String(maxSize)})`,
    );
    this.name = 'EventLogTooLargeError';
    this.size = size;
    this.maxSize = maxSize;
  }
}

export function assertEventLogSize(size: number): void {
  invariant(Number.isInteger(size), 'event log size must be an integer');
  invariant(size >= 0, 'event log size must be non-negative');
  if (size > MAX_EVENT_LOG_SIZE) {
    throw new EventLogTooLargeError(size, MAX_EVENT_LOG_SIZE);
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

function assertContiguousSequence(records: readonly EventRecord[]): void {
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

/** Parses JSONL content. Errors reference 1-based non-empty-line ordinals. */
export function parseEventLogContent(content: string): EventRecord[] {
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

/** Validates already-loaded records. Errors reference 0-based array indexes. */
export function validateEventRecords(
  events: readonly unknown[],
): EventRecord[] {
  const records = events.map((event, index) => {
    const parsedEvent = EventRecordSchema.safeParse(event);
    invariant(
      parsedEvent.success,
      `event log record ${String(index)} must match EventRecordSchema`,
    );
    return parsedEvent.data;
  });

  assertContiguousSequence(records);
  return records;
}

export async function readEventLogRecords(
  filePath: string,
): Promise<EventRecord[]> {
  invariant(filePath.length > 0, 'filePath must be a non-empty string');

  const fileStats = await stat(filePath);
  assertEventLogSize(fileStats.size);

  const content = await readFile(filePath, 'utf8');
  return parseEventLogContent(content);
}
