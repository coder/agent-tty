import { readFile, stat } from 'node:fs/promises';

import type { ReplayInput } from '../renderer/types.js';
import {
  EventRecordSchema,
  SessionRecordSchema,
  type EventRecord,
  type SessionRecord,
} from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';

export const MAX_EVENT_LOG_SIZE = 50 * 1024 * 1024;

function assertNonEmptyString(value: string, message: string): void {
  invariant(value.length > 0, message);
}

function parseEventRecord(event: unknown, index: number): EventRecord {
  const parsedEvent = EventRecordSchema.safeParse(event);
  invariant(
    parsedEvent.success,
    `replay event ${String(index)} must match EventRecordSchema`,
  );
  return parsedEvent.data;
}

function assertContiguousEventSequence(events: EventRecord[]): void {
  if (events.length === 0) {
    return;
  }

  invariant(events[0]?.seq === 0, 'first replay event seq must be 0');

  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];

    invariant(previous !== undefined, 'previous replay event must exist');
    invariant(current !== undefined, 'current replay event must exist');
    invariant(
      current.seq === previous.seq + 1,
      'replay events must have contiguous seq values',
    );
  }
}

function parseEventLogLine(line: string, lineNumber: number): EventRecord {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(line) as unknown;
  } catch {
    invariant(false, `event log line ${String(lineNumber)} must be valid JSON`);
  }

  return parseEventRecord(parsedLine, lineNumber);
}

export async function readEventLogRecords(
  filePath: string,
): Promise<EventRecord[]> {
  assertNonEmptyString(filePath, 'filePath must be a non-empty string');

  const fileStats = await stat(filePath);
  invariant(
    fileStats.size <= MAX_EVENT_LOG_SIZE,
    `event log file exceeds 50 MB size limit (${fileStats.size} bytes)`,
  );

  const content = await readFile(filePath, 'utf8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const events = lines.map((line, index) => parseEventLogLine(line, index + 1));
  assertContiguousEventSequence(events);
  return events;
}

export function buildReplayInput(
  sessionId: string,
  manifest: SessionRecord,
  events: EventRecord[],
  targetSeq?: number,
): ReplayInput {
  assertNonEmptyString(sessionId, 'sessionId must be a non-empty string');

  const parsedManifest = SessionRecordSchema.safeParse(manifest);
  invariant(parsedManifest.success, 'manifest must match SessionRecordSchema');
  invariant(
    parsedManifest.data.sessionId.length > 0,
    'manifest sessionId must be a non-empty string',
  );
  invariant(
    parsedManifest.data.sessionId === sessionId,
    'sessionId must match manifest sessionId',
  );
  invariant(parsedManifest.data.cols > 0, 'initial cols must be positive');
  invariant(parsedManifest.data.rows > 0, 'initial rows must be positive');

  const validatedEvents = events.map((event, index) =>
    parseEventRecord(event, index),
  );
  assertContiguousEventSequence(validatedEvents);

  let lastSeq = -1;
  if (validatedEvents.length > 0) {
    const lastEvent = validatedEvents.at(-1);
    invariant(lastEvent !== undefined, 'last replay event must exist');
    lastSeq = lastEvent.seq;
  }

  const resolvedTargetSeq = targetSeq ?? lastSeq;

  invariant(
    Number.isInteger(resolvedTargetSeq),
    'targetSeq must be an integer',
  );

  if (validatedEvents.length === 0) {
    invariant(
      resolvedTargetSeq === -1,
      'targetSeq must be -1 when replay has no events',
    );
  } else {
    invariant(resolvedTargetSeq >= 0, 'targetSeq must be non-negative');
    invariant(
      resolvedTargetSeq <= lastSeq,
      'targetSeq must not exceed the last event seq',
    );
  }

  return {
    sessionId,
    initialCols: parsedManifest.data.cols,
    initialRows: parsedManifest.data.rows,
    events: validatedEvents,
    targetSeq: resolvedTargetSeq,
  };
}
