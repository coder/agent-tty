import { open, readFile, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import {
  EventRecordSchema,
  type EventLogStop,
  type EventLogStopReason,
  type EventRecord,
} from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

export const MAX_EVENT_LOG_SIZE = 50 * 1024 * 1024;

/**
 * Start of the label of the marker that records why the log stopped. The rest
 * of the label names the limit that was reached: `(<n> bytes)` for the file
 * size, `(<n> events)` for the entry count. The host writer reserves the
 * prefix, so a marker that carries it is the stop marker.
 */
export const EVENT_LOG_LIMIT_LABEL_PREFIX =
  'agent-tty: event log limit reached';

/** The limits that stop a log. A reader may also find `unknown`. */
export type EventLogLimit = Exclude<EventLogStopReason, 'unknown'>;

/**
 * The label of the stop marker. It names the limit that stopped the log, as
 * `(<n> bytes)` or `(<n> events)`, and `findEventLogStop` reads it back.
 */
export function eventLogStopLabel(
  reason: EventLogLimit,
  limit: number,
): string {
  return `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(limit)} ${reason}); later events are not recorded`;
}

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

function assertSeqFollows(previousSeq: number | undefined, seq: number): void {
  if (previousSeq === undefined) {
    invariant(seq === 0, 'first event log seq must be 0');
    return;
  }

  invariant(
    seq === previousSeq + 1,
    'event log seq values must increase by 1 without gaps',
  );
}

function assertContiguousSequence(records: readonly EventRecord[]): void {
  let previousSeq: number | undefined;
  for (const record of records) {
    assertSeqFollows(previousSeq, record.seq);
    previousSeq = record.seq;
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

type MarkerEventRecord = Extract<EventRecord, { type: 'marker' }>;

/** True for the marker that the host writes when the log stops. */
export function isEventLogStopMarker(
  record: EventRecord,
): record is MarkerEventRecord {
  return (
    record.type === 'marker' &&
    record.payload.label.startsWith(EVENT_LOG_LIMIT_LABEL_PREFIX)
  );
}

function stopOfMarker(marker: MarkerEventRecord): EventLogStop {
  const limit = /^ \(\d+ (bytes|events)\)/.exec(
    marker.payload.label.slice(EVENT_LOG_LIMIT_LABEL_PREFIX.length),
  )?.[1];
  // The prefix is reserved, so only a log that agent-tty did not write holds
  // a stop marker with no limit. The host still honours it as a stop.
  return {
    reason: limit === 'bytes' || limit === 'events' ? limit : 'unknown',
    seq: marker.seq,
  };
}

/**
 * Returns where the log stopped: the `seq` of its first stop marker and the
 * limit that the marker names. Returns `undefined` when `records` hold no
 * stop marker. `EventLog.open` uses the same check to start a reopened log
 * stopped.
 */
export function findEventLogStop(
  records: readonly EventRecord[],
): EventLogStop | undefined {
  const marker = records.find(isEventLogStopMarker);
  return marker === undefined ? undefined : stopOfMarker(marker);
}

export interface EventLogScan {
  /** Non-blank lines of the file, valid or not. */
  readonly entryCount: number;
  /** Bytes of the file that the scan read. */
  readonly byteCount: number;
  /** See `scanEventLog`. */
  readonly stop: EventLogStop | undefined;
}

/**
 * Reads the file once and returns what it holds. All three results describe
 * the same bytes: the file as it was when the scan measured it, so a live
 * host that appends meanwhile cannot make them disagree. Returns `undefined`
 * when the file does not exist.
 *
 * `stop` is the first stop marker that a replay would reach: the scan parses
 * lines with the codec of `parseEventLogContent`, and it stops looking at the
 * first line that is not a valid record with the next `seq`. A line that the
 * live host has not finished writing ends the search the same way. So a log
 * that replay rejects can still be counted here, and a marker after the
 * first bad line is not reported.
 *
 * Unlike `readEventLogRecords`, it does not enforce `MAX_EVENT_LOG_SIZE`: it
 * streams the file, so it also reads a log that an older version wrote past
 * the limit.
 */
export async function scanEventLog(
  filePath: string,
): Promise<EventLogScan | undefined> {
  invariant(filePath.length > 0, 'filePath must be a non-empty string');

  let file: FileHandle;
  try {
    file = await open(filePath, 'r');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }

  try {
    const { size } = await file.stat();
    let entryCount = 0;
    let stop: EventLogStop | undefined;
    let previousSeq: number | undefined;
    let searching = true;

    if (size > 0) {
      const lineReader = createInterface({
        input: file.createReadStream({
          encoding: 'utf8',
          start: 0,
          end: size - 1,
          autoClose: false,
        }),
        crlfDelay: Infinity,
      });

      for await (const rawLine of lineReader) {
        const line = rawLine.trim();
        if (line.length === 0) {
          continue;
        }

        entryCount += 1;
        if (!searching) {
          continue;
        }

        try {
          const record = parseEventLogLine(line, entryCount);
          assertSeqFollows(previousSeq, record.seq);
          previousSeq = record.seq;
          if (isEventLogStopMarker(record)) {
            stop = stopOfMarker(record);
            searching = false;
          }
        } catch {
          searching = false;
        }
      }
    }

    return { entryCount, byteCount: size, stop };
  } finally {
    await file.close();
  }
}
