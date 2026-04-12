import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countEventLogEntries,
  EventLog,
  MAX_EVENT_BUFFER_ENTRIES,
} from '../../../src/host/eventLog.js';
import { MAX_EVENT_LOG_SIZE } from '../../../src/host/replay.js';

let tempDir = '';
let eventLogPath = '';

describe('countEventLogEntries', () => {
  beforeEach(async () => {
    // prettier-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-event-log-')));
    eventLogPath = join(tempDir, 'events.jsonl');
  });

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns 0 when the event log file is missing', async () => {
    await expect(countEventLogEntries(eventLogPath)).resolves.toBe(0);
  });

  it('returns 0 for an empty event log file', async () => {
    await writeFile(eventLogPath, '', 'utf8');

    await expect(countEventLogEntries(eventLogPath)).resolves.toBe(0);
  });

  it('counts non-empty lines in a JSONL event log', async () => {
    await writeFile(
      eventLogPath,
      [
        JSON.stringify({ seq: 0, type: 'output' }),
        '',
        '   ',
        JSON.stringify({ seq: 1, type: 'resize' }),
      ].join('\n'),
      'utf8',
    );

    await expect(countEventLogEntries(eventLogPath)).resolves.toBe(2);
  });
});

describe('EventLog', () => {
  beforeEach(async () => {
    // prettier-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-event-log-')));
    eventLogPath = join(tempDir, 'events.jsonl');
    await writeFile(eventLogPath, '', 'utf8');
  });

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('readAll returns validated events in contiguous order', async () => {
    const eventLog = await EventLog.open(eventLogPath);

    try {
      await eventLog.append('output', { data: 'hello' });
      await eventLog.append('resize', { cols: 100, rows: 30 });
      await eventLog.append('signal', { signal: 'SIGTERM' });

      const events = await eventLog.readAll();
      expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
      expect(events.map((event) => event.type)).toEqual([
        'output',
        'resize',
        'signal',
      ]);
    } finally {
      await eventLog.close();
    }
  });

  it('returns committed sequence numbers for marker appends and keeps them monotonic', async () => {
    const eventLog = await EventLog.open(eventLogPath);

    try {
      const firstSeq = await eventLog.append('marker', { label: 'test' });
      const secondSeq = await eventLog.append('output', { data: 'hello' });
      const thirdSeq = await eventLog.append('marker', { label: '' });

      expect([firstSeq, secondSeq, thirdSeq]).toEqual([0, 1, 2]);
      expect(eventLog.getEvents().map((event) => event.seq)).toEqual([0, 1, 2]);
      expect(eventLog.getEvents().map((event) => event.type)).toEqual([
        'marker',
        'output',
        'marker',
      ]);
      expect(eventLog.getEvents().map((event) => event.payload)).toEqual([
        { label: 'test' },
        { data: 'hello' },
        { label: '' },
      ]);
    } finally {
      await eventLog.close();
    }
  });

  it('returns buffered events without rereading the log file', async () => {
    const eventLog = await EventLog.open(eventLogPath);

    try {
      await eventLog.append('output', { data: 'hello' });
      await writeFile(
        eventLogPath,
        [
          JSON.stringify({
            seq: 0,
            ts: '2026-03-19T12:00:00.000Z',
            type: 'output',
            payload: { data: 'disk-only' },
          }),
          JSON.stringify({
            seq: 2,
            ts: '2026-03-19T12:00:01.000Z',
            type: 'output',
            payload: { data: 'gap' },
          }),
          '',
        ].join('\n'),
        'utf8',
      );

      expect(eventLog.getEvents().map((event) => event.payload)).toEqual([
        { data: 'hello' },
      ]);
      expect(eventLog.getEventsSince(-1).map((event) => event.seq)).toEqual([
        0,
      ]);
      expect(eventLog.getEventsSince(0)).toEqual([]);
      await expect(eventLog.readAll()).resolves.toEqual(eventLog.getEvents());
    } finally {
      await eventLog.close();
    }
  });

  it('hydrates the in-memory buffer from an existing log on open', async () => {
    await writeFile(
      eventLogPath,
      [
        JSON.stringify({
          seq: 0,
          ts: '2026-03-19T12:00:00.000Z',
          type: 'output',
          payload: { data: 'hello' },
        }),
        JSON.stringify({
          seq: 1,
          ts: '2026-03-19T12:00:01.000Z',
          type: 'resize',
          payload: { cols: 100, rows: 30 },
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    const eventLog = await EventLog.open(eventLogPath);

    try {
      expect(eventLog.getEvents().map((event) => event.seq)).toEqual([0, 1]);
      expect(eventLog.getEventsSince(0).map((event) => event.type)).toEqual([
        'resize',
      ]);

      await eventLog.append('signal', { signal: 'SIGTERM' });

      expect((await eventLog.readAll()).map((event) => event.seq)).toEqual([
        0, 1, 2,
      ]);
    } finally {
      await eventLog.close();
    }
  });

  it('rejects oversized logs before reading them into memory', async () => {
    await truncate(eventLogPath, MAX_EVENT_LOG_SIZE + 1);

    await expect(EventLog.open(eventLogPath)).rejects.toThrow(
      `event log file exceeds size limit (${String(MAX_EVENT_LOG_SIZE + 1)} bytes, max ${String(MAX_EVENT_LOG_SIZE)})`,
    );
  });

  it('rejects appends when the in-memory buffer reaches the runtime cap', async () => {
    const eventLog = await EventLog.open(eventLogPath);
    const eventLogInternals = eventLog as unknown as {
      eventBuffer: unknown[];
      nextSeq: number;
    };

    try {
      eventLogInternals.eventBuffer = new Array(
        MAX_EVENT_BUFFER_ENTRIES,
      ) as unknown[];
      eventLogInternals.nextSeq = MAX_EVENT_BUFFER_ENTRIES;

      await expect(
        eventLog.append('output', { data: 'overflow' }),
      ).rejects.toThrow(
        `event buffer exceeds ${String(MAX_EVENT_BUFFER_ENTRIES)} entries; session event log is too large`,
      );

      expect(eventLogInternals.eventBuffer).toHaveLength(
        MAX_EVENT_BUFFER_ENTRIES,
      );
      expect(eventLogInternals.nextSeq).toBe(MAX_EVENT_BUFFER_ENTRIES);
    } finally {
      await eventLog.close();
    }
  });

  it('rolls back buffered events when append disk writes fail', async () => {
    const eventLog = await EventLog.open(eventLogPath);
    const eventLogInternals = eventLog as unknown as {
      fileHandle: {
        appendFile: (data: string, encoding: BufferEncoding) => Promise<void>;
      };
      nextSeq: number;
      writeQueue: Promise<void>;
    };

    try {
      await eventLog.append('output', { data: 'persisted' });
      const appendFileSpy = vi
        .spyOn(eventLogInternals.fileHandle, 'appendFile')
        .mockRejectedValueOnce(new Error('disk full'));

      await expect(
        eventLog.append('signal', { signal: 'SIGTERM' }),
      ).rejects.toThrow('disk full');

      expect(eventLog.getEvents().map((event) => event.seq)).toEqual([0]);
      expect(eventLog.getEvents().map((event) => event.type)).toEqual([
        'output',
      ]);
      expect(eventLogInternals.nextSeq).toBe(1);

      const logContent = await readFile(eventLogPath, 'utf8');
      expect(logContent).toContain('"seq":0');
      expect(logContent).not.toContain('"seq":1');

      appendFileSpy.mockRestore();
      eventLogInternals.writeQueue = Promise.resolve();
    } finally {
      await eventLog.close();
    }
  });

  it('rejects gaps in stored sequence numbers when opening the log', async () => {
    await writeFile(
      eventLogPath,
      [
        JSON.stringify({
          seq: 0,
          ts: '2026-03-19T12:00:00.000Z',
          type: 'output',
          payload: { data: 'hello' },
        }),
        JSON.stringify({
          seq: 2,
          ts: '2026-03-19T12:00:01.000Z',
          type: 'output',
          payload: { data: 'world' },
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    await expect(EventLog.open(eventLogPath)).rejects.toThrow(
      'event log seq values must increase by 1 without gaps',
    );
  });
});
