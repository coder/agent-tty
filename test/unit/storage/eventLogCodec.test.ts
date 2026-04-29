import { mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EventRecord } from '../../../src/protocol/schemas.js';
import {
  assertEventLogSize,
  MAX_EVENT_LOG_SIZE,
  parseEventLogContent,
  readEventLogRecords,
  validateEventRecords,
} from '../../../src/storage/eventLogCodec.js';

type OutputEventRecord = Extract<EventRecord, { type: 'output' }>;

function createEvent(
  overrides: Partial<OutputEventRecord> = {},
): OutputEventRecord {
  return {
    seq: 0,
    ts: '2026-03-19T12:00:00.000Z',
    type: 'output',
    payload: { data: 'hello' },
    ...overrides,
  };
}

function createEvents(): EventRecord[] {
  return [
    createEvent(),
    {
      seq: 1,
      ts: '2026-03-19T12:00:01.000Z',
      type: 'resize',
      payload: { cols: 100, rows: 30 },
    },
  ];
}

function createEventLogContent(events: readonly EventRecord[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

let tempDir = '';
let eventLogPath = '';

describe('event log codec', () => {
  beforeEach(async () => {
    // prettier-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-event-log-codec-')));
    eventLogPath = join(tempDir, 'events.jsonl');
  });

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts event logs at the maximum size and rejects larger logs', () => {
    expect(() => assertEventLogSize(MAX_EVENT_LOG_SIZE)).not.toThrow();
    expect(() => assertEventLogSize(MAX_EVENT_LOG_SIZE + 1)).toThrow(
      `event log file exceeds size limit (${String(MAX_EVENT_LOG_SIZE + 1)} bytes, max ${String(MAX_EVENT_LOG_SIZE)})`,
    );
  });

  it('rejects negative and fractional event log sizes', () => {
    expect(() => assertEventLogSize(-1)).toThrow(
      'event log size must be non-negative',
    );
    expect(() => assertEventLogSize(3.5)).toThrow(
      'event log size must be an integer',
    );
  });

  it('rejects oversized event log files before reading content', async () => {
    await writeFile(eventLogPath, '', 'utf8');
    await truncate(eventLogPath, MAX_EVENT_LOG_SIZE + 1);

    await expect(readEventLogRecords(eventLogPath)).rejects.toThrow(
      `event log file exceeds size limit (${String(MAX_EVENT_LOG_SIZE + 1)} bytes, max ${String(MAX_EVENT_LOG_SIZE)})`,
    );
  });

  it('parses empty event log content as no records', () => {
    expect(parseEventLogContent('')).toEqual([]);
  });

  it('parses valid JSONL event log content', () => {
    const events = createEvents();

    expect(parseEventLogContent(createEventLogContent(events))).toEqual(events);
  });

  it('reads valid JSONL event log files', async () => {
    const events = createEvents();
    await writeFile(eventLogPath, createEventLogContent(events), 'utf8');

    await expect(readEventLogRecords(eventLogPath)).resolves.toEqual(events);
  });

  it('reads legacy JSONL logs without run_complete events', async () => {
    const events: EventRecord[] = [
      createEvent({
        payload: { data: 'legacy output' },
      }),
      {
        seq: 1,
        ts: '2026-03-19T12:00:01.000Z',
        type: 'input_run',
        payload: {
          command: 'echo done',
          marker: '__AT_MARKER_legacy__',
          noWait: false,
        },
      },
      {
        seq: 2,
        ts: '2026-03-19T12:00:02.000Z',
        type: 'exit',
        payload: { exitCode: 0, exitSignal: null },
      },
    ];
    await writeFile(eventLogPath, createEventLogContent(events), 'utf8');

    await expect(readEventLogRecords(eventLogPath)).resolves.toEqual(events);
  });

  it('ignores blank and whitespace-only JSONL lines', () => {
    const events = createEvents();
    const content = [
      '',
      '   ',
      JSON.stringify(events[0]),
      '',
      '\t',
      JSON.stringify(events[1]),
      '',
    ].join('\n');

    expect(parseEventLogContent(content)).toEqual(events);
  });

  it('reports malformed JSON using non-empty line ordinals', () => {
    expect(() => parseEventLogContent('\n  \n{"seq":0')).toThrow(
      'event log line 1 must be valid JSON',
    );
  });

  it('rejects malformed JSONL lines', () => {
    expect(() =>
      parseEventLogContent(`${JSON.stringify(createEvent())}\n{"seq":1`),
    ).toThrow('event log line 2 must be valid JSON');
  });

  it('rejects invalid JSONL event record shapes with line numbers', () => {
    expect(() =>
      parseEventLogContent(
        JSON.stringify({
          seq: 0,
          ts: '2026-03-19T12:00:00.000Z',
          type: 'output',
          payload: {},
        }),
      ),
    ).toThrow('event log line 1 must match EventRecordSchema');
  });

  it('rejects invalid loaded event records with zero-based record indexes', () => {
    expect(() =>
      validateEventRecords([
        {
          seq: 0,
          ts: '2026-03-19T12:00:00.000Z',
          type: 'output',
          payload: {},
        },
      ]),
    ).toThrow('event log record 0 must match EventRecordSchema');
  });

  it('rejects event logs whose first sequence is not zero', () => {
    expect(() =>
      parseEventLogContent(JSON.stringify(createEvent({ seq: 1 }))),
    ).toThrow('first event log seq must be 0');
  });

  it('rejects event log sequence gaps', () => {
    const events = [createEvent(), createEvent({ seq: 2 })];

    expect(() => parseEventLogContent(createEventLogContent(events))).toThrow(
      'event log seq values must increase by 1 without gaps',
    );
  });

  it('rejects duplicate event log sequence numbers', () => {
    const events = [createEvent(), createEvent({ seq: 0 })];

    expect(() => parseEventLogContent(createEventLogContent(events))).toThrow(
      'event log seq values must increase by 1 without gaps',
    );
  });

  it('rejects decreasing event log sequence numbers', () => {
    const events = [
      createEvent(),
      createEvent({ seq: 1 }),
      createEvent({ seq: 0 }),
    ];

    expect(() => validateEventRecords(events)).toThrow(
      'event log seq values must increase by 1 without gaps',
    );
  });

  it('validates an empty array of loaded event records', () => {
    expect(validateEventRecords([])).toEqual([]);
  });

  it('validates already-loaded event records', () => {
    const events = createEvents();

    expect(validateEventRecords(events)).toEqual(events);
  });

  it('rejects non-contiguous already-loaded event records', () => {
    const events = [createEvent(), createEvent({ seq: 2 })];

    expect(() => validateEventRecords(events)).toThrow(
      'event log seq values must increase by 1 without gaps',
    );
  });

  it('propagates ENOENT for missing event log files', async () => {
    await expect(readEventLogRecords(eventLogPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
