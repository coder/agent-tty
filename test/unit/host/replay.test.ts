import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_EVENT_LOG_SIZE,
  buildReplayInput,
  readEventLogRecords,
} from '../../../src/host/replay.js';
import type {
  EventRecord,
  SessionRecord,
} from '../../../src/protocol/schemas.js';

function createManifest(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
    ...overrides,
  };
}

function createEvents(): EventRecord[] {
  return [
    {
      seq: 0,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'output',
      payload: { data: 'hello' },
    },
    {
      seq: 1,
      ts: '2026-03-19T12:00:03.000Z',
      type: 'resize',
      payload: { cols: 100, rows: 30 },
    },
  ];
}

let tempDir = '';
let eventLogPath = '';

describe('replay helpers', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-terminal-replay-'));
    eventLogPath = join(tempDir, 'events.jsonl');
  });

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('buildReplayInput constructs a replay input from manifest and events', () => {
    const replayInput = buildReplayInput(
      'session-01',
      createManifest(),
      createEvents(),
    );

    expect(replayInput).toEqual({
      sessionId: 'session-01',
      initialCols: 80,
      initialRows: 24,
      events: createEvents(),
      targetSeq: 1,
    });
  });

  it('buildReplayInput respects an explicit target sequence', () => {
    const replayInput = buildReplayInput(
      'session-01',
      createManifest(),
      createEvents(),
      0,
    );

    expect(replayInput.targetSeq).toBe(0);
  });

  it('buildReplayInput rejects out-of-order sequences', () => {
    const firstEvent = createEvents().at(0);
    expect(firstEvent).toBeDefined();

    if (firstEvent === undefined) {
      return;
    }

    expect(() =>
      buildReplayInput('session-01', createManifest(), [
        firstEvent,
        {
          seq: 3,
          ts: '2026-03-19T12:00:04.000Z',
          type: 'output',
          payload: { data: 'world' },
        },
      ]),
    ).toThrow('replay events must have contiguous seq values');
  });

  it('buildReplayInput rejects invalid session identifiers and dimensions', () => {
    expect(() =>
      buildReplayInput('', createManifest(), createEvents()),
    ).toThrow('sessionId must be a non-empty string');
    expect(() =>
      buildReplayInput(
        'session-01',
        createManifest({ cols: 0 }),
        createEvents(),
      ),
    ).toThrow('manifest must match SessionRecordSchema');
  });

  it('readEventLogRecords rejects event logs larger than 50 MB', async () => {
    const fileHandle = await open(eventLogPath, 'w');

    try {
      await fileHandle.truncate(MAX_EVENT_LOG_SIZE + 1);
    } finally {
      await fileHandle.close();
    }

    await expect(readEventLogRecords(eventLogPath)).rejects.toThrow(
      `event log file exceeds 50 MB size limit (${String(MAX_EVENT_LOG_SIZE + 1)} bytes)`,
    );
  });

  it('readEventLogRecords parses and validates JSONL event logs', async () => {
    await writeFile(
      eventLogPath,
      createEvents()
        .map((event) => JSON.stringify(event))
        .concat('')
        .join('\n'),
      'utf8',
    );

    const events = await readEventLogRecords(eventLogPath);
    expect(events).toEqual(createEvents());
  });
});
