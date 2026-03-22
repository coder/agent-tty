import type { EventRecord, SessionRecord } from '../protocol/schemas.js';

import { invariant } from '../util/assert.js';

const DEFAULT_TERM = 'xterm-256color';

export interface AsciicastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  title: string;
  env: {
    TERM: string;
  };
}

export interface AsciicastExport {
  contents: string;
  header: AsciicastHeader;
  capturedAtSeq: number;
  durationMs: number;
  outputEventCount: number;
  resizeEventCount: number;
  markerCount: number;
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  invariant(
    Number.isFinite(timestamp),
    `${label} must be a valid ISO timestamp`,
  );
  return timestamp;
}

function relativeSeconds(
  eventTimestampMs: number,
  baseTimestampMs: number,
): number {
  invariant(
    eventTimestampMs >= baseTimestampMs,
    'event timestamps must not precede the first event timestamp',
  );
  return (eventTimestampMs - baseTimestampMs) / 1000;
}

export function generateAsciicast(
  sessionId: string,
  manifest: SessionRecord,
  events: EventRecord[],
): AsciicastExport {
  invariant(sessionId.length > 0, 'sessionId must be a non-empty string');
  invariant(
    manifest.sessionId === sessionId,
    'manifest sessionId must match the export sessionId',
  );
  invariant(manifest.cols > 0, 'manifest cols must be positive');
  invariant(manifest.rows > 0, 'manifest rows must be positive');

  const fallbackTimestampMs = parseTimestamp(
    manifest.createdAt,
    'manifest.createdAt',
  );
  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  const firstTimestampMs =
    firstEvent !== undefined
      ? parseTimestamp(firstEvent.ts, 'events[0].ts')
      : fallbackTimestampMs;
  const lastTimestampMs =
    lastEvent !== undefined
      ? parseTimestamp(lastEvent.ts, 'events[last].ts')
      : firstTimestampMs;

  invariant(
    lastTimestampMs >= firstTimestampMs,
    'last event timestamp must not precede the first event timestamp',
  );

  const header: AsciicastHeader = {
    version: 2,
    width: manifest.cols,
    height: manifest.rows,
    timestamp: Math.floor(firstTimestampMs / 1000),
    title: sessionId,
    env: {
      TERM: DEFAULT_TERM,
    },
  };

  let previousTimestampMs = firstTimestampMs;
  let outputEventCount = 0;
  let resizeEventCount = 0;
  let markerCount = 0;
  const lines = [JSON.stringify(header)];

  for (const event of events) {
    const eventTimestampMs = parseTimestamp(
      event.ts,
      `event ${String(event.seq)} timestamp`,
    );
    invariant(
      eventTimestampMs >= previousTimestampMs,
      'event timestamps must be non-decreasing',
    );
    previousTimestampMs = eventTimestampMs;

    if (event.type === 'output') {
      outputEventCount += 1;
      lines.push(
        JSON.stringify([
          relativeSeconds(eventTimestampMs, firstTimestampMs),
          'o',
          event.payload.data,
        ]),
      );
      continue;
    }

    if (event.type === 'resize') {
      resizeEventCount += 1;
      lines.push(
        JSON.stringify([
          relativeSeconds(eventTimestampMs, firstTimestampMs),
          'r',
          `${String(event.payload.cols)}x${String(event.payload.rows)}`,
        ]),
      );
      continue;
    }

    if (event.type === 'marker') {
      markerCount += 1;
      lines.push(
        JSON.stringify([
          relativeSeconds(eventTimestampMs, firstTimestampMs),
          'm',
          event.payload.label,
        ]),
      );
    }
  }

  return {
    contents: `${lines.join('\n')}\n`,
    header,
    capturedAtSeq: events.at(-1)?.seq ?? 0,
    durationMs: Math.max(0, lastTimestampMs - firstTimestampMs),
    outputEventCount,
    resizeEventCount,
    markerCount,
  };
}
