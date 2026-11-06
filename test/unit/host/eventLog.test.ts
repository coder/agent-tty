import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateAsciicast } from '../../../src/export/asciicast.js';
import {
  countEventLogEntries,
  EVENT_LOG_LIMIT_LABEL_PREFIX,
  EVENT_LOG_TAIL_RESERVE_BYTES,
  EVENT_LOG_TAIL_RESERVE_ENTRIES,
  EventLog,
  MAX_EVENT_BUFFER_ENTRIES,
  statEventLogBytes,
} from '../../../src/host/eventLog.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';
import {
  MAX_EVENT_LOG_SIZE,
  readEventLogRecords,
} from '../../../src/storage/eventLogCodec.js';

let tempDir = '';
let eventLogPath = '';

describe('countEventLogEntries', () => {
  beforeEach(async () => {
    // oxfmt-ignore
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

describe('statEventLogBytes', () => {
  beforeEach(async () => {
    // oxfmt-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-event-log-')));
    eventLogPath = join(tempDir, 'events.jsonl');
  });

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when the event log file is missing', async () => {
    await expect(statEventLogBytes(eventLogPath)).resolves.toBeUndefined();
  });

  it('returns 0 for an empty event log file', async () => {
    await writeFile(eventLogPath, '', 'utf8');

    await expect(statEventLogBytes(eventLogPath)).resolves.toBe(0);
  });

  it('returns the byte size of a populated event log file', async () => {
    const payload = `${JSON.stringify({ seq: 0, type: 'output' })}\n`;
    await writeFile(eventLogPath, payload, 'utf8');

    await expect(statEventLogBytes(eventLogPath)).resolves.toBe(
      Buffer.byteLength(payload, 'utf8'),
    );
  });

  it('rejects empty file paths', async () => {
    await expect(statEventLogBytes('')).rejects.toThrow();
  });

  it('rethrows non-ENOENT errors so callers see them', async () => {
    // A path whose parent is a regular file rather than a directory triggers
    // ENOTDIR from stat(), which must propagate (only ENOENT may be swallowed).
    const blocker = join(tempDir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const childOfFile = join(blocker, 'events.jsonl');

    await expect(statEventLogBytes(childOfFile)).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});

describe('EventLog', () => {
  beforeEach(async () => {
    // oxfmt-ignore
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

  it('startAppend reserves the seq before its write settles', async () => {
    const eventLog = await EventLog.open(eventLogPath);

    try {
      const started = eventLog.startAppend('input_run', {
        command: 'echo hi',
        noWait: false,
        marker: `__AT_MARKER_${'a'.repeat(32)}__`,
      });
      expect(started.seq).toBe(0);
      expect(eventLog.getEvents().map((event) => event.type)).toEqual([
        'input_run',
      ]);

      const nextSeq = eventLog.append('input_text', { data: 'x' });
      await expect(started.written).resolves.toBe(0);
      await expect(nextSeq).resolves.toBe(1);
      const lines = (await readFile(eventLogPath, 'utf8')).trim().split('\n');
      expect(lines.map((line) => JSON.parse(line) as { type: string })).toEqual(
        [
          expect.objectContaining({ seq: 0, type: 'input_run' }),
          expect.objectContaining({ seq: 1, type: 'input_text' }),
        ],
      );
    } finally {
      await eventLog.close();
    }
  });

  it('rolls back a startAppend whose write fails and keeps the file a valid prefix', async () => {
    const eventLog = await EventLog.open(eventLogPath);
    const eventLogInternals = eventLog as unknown as {
      fileHandle: {
        appendFile: (data: string, encoding: BufferEncoding) => Promise<void>;
      };
      nextSeq: number;
      writeQueue: Promise<void>;
    };

    try {
      await eventLog.append('output', { data: 'prompt$ ' });
      const appendFileSpy = vi
        .spyOn(eventLogInternals.fileHandle, 'appendFile')
        .mockRejectedValueOnce(new Error('EIO'));
      const started = eventLog.startAppend('input_run', {
        command: 'echo hi',
        noWait: false,
        marker: `__AT_MARKER_${'b'.repeat(32)}__`,
      });
      expect(started.seq).toBe(1);
      const queuedOutput = eventLog.append('output', { data: 'hi\r\n' });

      await expect(started.written).rejects.toThrow('EIO');
      await expect(queuedOutput).rejects.toThrow('EIO');
      expect(eventLog.getEvents().map((event) => event.seq)).toEqual([0]);
      expect(eventLogInternals.nextSeq).toBe(1);
      appendFileSpy.mockRestore();
      await expect(
        eventLog.append('output', { data: 'later' }),
      ).rejects.toThrow('EIO');

      const lines = (await readFile(eventLogPath, 'utf8')).trim().split('\n');
      expect(
        lines.map((line) => (JSON.parse(line) as { seq: number }).seq),
      ).toEqual([0]);
      const reopened = await EventLog.open(eventLogPath);
      try {
        await expect(reopened.append('output', { data: 'x' })).resolves.toBe(1);
      } finally {
        await reopened.close();
      }
      eventLogInternals.writeQueue = Promise.resolve();
    } finally {
      await eventLog.close();
    }
  });

  it('appends run_complete events and round-trips them from JSONL', async () => {
    const eventLog = await EventLog.open(eventLogPath);

    try {
      const firstSeq = await eventLog.append('run_complete', {
        marker: '__AT_MARKER_first__',
      });
      const secondSeq = await eventLog.append('run_complete', {
        marker: '__AT_MARKER_second__',
        inputRunSeq: 12,
      });

      expect([firstSeq, secondSeq]).toEqual([0, 1]);
      expect(await eventLog.readAll()).toEqual([
        expect.objectContaining({
          seq: 0,
          type: 'run_complete',
          payload: { marker: '__AT_MARKER_first__' },
        }),
        expect.objectContaining({
          seq: 1,
          type: 'run_complete',
          payload: { marker: '__AT_MARKER_second__', inputRunSeq: 12 },
        }),
      ]);
    } finally {
      await eventLog.close();
    }

    const reopenedEventLog = await EventLog.open(eventLogPath);

    try {
      expect(reopenedEventLog.getEvents()).toEqual([
        expect.objectContaining({
          seq: 0,
          type: 'run_complete',
          payload: { marker: '__AT_MARKER_first__' },
        }),
        expect.objectContaining({
          seq: 1,
          type: 'run_complete',
          payload: { marker: '__AT_MARKER_second__', inputRunSeq: 12 },
        }),
      ]);

      const logLines = (await readFile(eventLogPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      expect(logLines).toEqual(reopenedEventLog.getEvents());
    } finally {
      await reopenedEventLog.close();
    }
  });

  it('appends input_mouse events and round-trips their semantic and wire data', async () => {
    const eventLog = await EventLog.open(eventLogPath);

    try {
      const seq = await eventLog.append('input_mouse', {
        action: 'move',
        row: 3,
        col: 8,
        modifiers: { shift: false, alt: false, ctrl: true },
        rendererBackend: 'libghostty-vt',
        dataBase64: Buffer.from('\u001b[<48;9;4M').toString('base64'),
      });

      expect(seq).toBe(0);
      expect(await eventLog.readAll()).toEqual([
        expect.objectContaining({
          seq: 0,
          type: 'input_mouse',
          payload: {
            action: 'move',
            row: 3,
            col: 8,
            modifiers: { shift: false, alt: false, ctrl: true },
            rendererBackend: 'libghostty-vt',
            dataBase64: Buffer.from('\u001b[<48;9;4M').toString('base64'),
          },
        }),
      ]);
    } finally {
      await eventLog.close();
    }

    const reopenedEventLog = await EventLog.open(eventLogPath);
    try {
      expect(reopenedEventLog.getEvents()).toMatchObject([
        {
          seq: 0,
          type: 'input_mouse',
          payload: {
            dataBase64: Buffer.from('\u001b[<48;9;4M').toString('base64'),
          },
        },
      ]);
    } finally {
      await reopenedEventLog.close();
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

  it('stops at the in-memory entry cap instead of throwing', async () => {
    const eventLog = await EventLog.open(eventLogPath);
    const eventLogInternals = eventLog as unknown as {
      eventBuffer: unknown[];
      nextSeq: number;
    };

    try {
      // Stand in for a log that holds all but the two reserved entries.
      eventLogInternals.eventBuffer = new Array(
        MAX_EVENT_BUFFER_ENTRIES - 2,
      ) as unknown[];
      eventLogInternals.nextSeq = MAX_EVENT_BUFFER_ENTRIES - 2;

      await expect(
        eventLog.append('output', { data: 'overflow' }),
      ).resolves.toBe(MAX_EVENT_BUFFER_ENTRIES - 2);
      await expect(
        eventLog.append('output', { data: 'dropped' }),
      ).resolves.toBe(MAX_EVENT_BUFFER_ENTRIES - 2);
      await expect(
        eventLog.append('exit', { exitCode: 0, exitSignal: null }),
      ).resolves.toBe(MAX_EVENT_BUFFER_ENTRIES - 1);
      await expect(
        eventLog.append('output', { data: 'after the exit' }),
      ).resolves.toBe(MAX_EVENT_BUFFER_ENTRIES - 1);

      expect(eventLogInternals.eventBuffer).toHaveLength(
        MAX_EVENT_BUFFER_ENTRIES,
      );
      expect(eventLogInternals.nextSeq).toBe(MAX_EVENT_BUFFER_ENTRIES);

      const written = (await readFile(eventLogPath, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              seq: number;
              type: string;
              payload: { label?: string };
            },
        );
      expect(written.map((record) => [record.seq, record.type])).toEqual([
        [MAX_EVENT_BUFFER_ENTRIES - 2, 'marker'],
        [MAX_EVENT_BUFFER_ENTRIES - 1, 'exit'],
      ]);
      expect(written[0]?.payload.label).toBe(
        `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(MAX_EVENT_BUFFER_ENTRIES)} events); later events are not recorded`,
      );
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

describe('EventLog size limit', () => {
  // Small enough to reach with a few dozen appends, large enough to leave
  // room beyond the tail reserve.
  const LIMIT = EVENT_LOG_TAIL_RESERVE_BYTES * 2;

  beforeEach(async () => {
    // oxfmt-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-event-log-limit-')));
    eventLogPath = join(tempDir, 'events.jsonl');
    await writeFile(eventLogPath, '', 'utf8');
  });

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function fileBytes(): Promise<number> {
    return (await stat(eventLogPath)).size;
  }

  async function fillUntilStopped(eventLog: EventLog): Promise<void> {
    for (let index = 0; index < 1000; index += 1) {
      await eventLog.append('output', { data: `line ${String(index)}\r\n` });
      if (eventLog.getEvents().some((event) => event.type === 'marker')) {
        return;
      }
    }
    expect.unreachable('the log never stopped');
  }

  function stopRecords(eventLog: EventLog): readonly unknown[] {
    return eventLog
      .getEvents()
      .filter(
        (event) =>
          event.type === 'marker' &&
          event.payload.label.startsWith(EVENT_LOG_LIMIT_LABEL_PREFIX),
      );
  }

  function outputLine(seq: number, data: string): string {
    return `${JSON.stringify({
      seq,
      ts: '2026-03-19T12:00:00.000Z',
      type: 'output',
      payload: { data },
    })}\n`;
  }

  /** Writes `count` records, as a log that an earlier host left behind. */
  async function prefillEntries(count: number): Promise<void> {
    let contents = '';
    for (let seq = 0; seq < count; seq += 1) {
      contents += outputLine(seq, 'earlier');
    }
    await writeFile(eventLogPath, contents, 'utf8');
  }

  /** Writes records that make a file of exactly `totalBytes` bytes. */
  async function prefillBytes(totalBytes: number): Promise<number> {
    let contents = '';
    let seq = 0;
    while (
      totalBytes - Buffer.byteLength(contents) >=
      2 * (Buffer.byteLength(outputLine(seq, '')) + 100)
    ) {
      contents += outputLine(seq, 'a'.repeat(100));
      seq += 1;
    }
    const lastData =
      totalBytes -
      Buffer.byteLength(contents) -
      Buffer.byteLength(outputLine(seq, ''));
    contents += outputLine(seq, 'z'.repeat(lastData));
    seq += 1;
    expect(Buffer.byteLength(contents)).toBe(totalBytes);
    await writeFile(eventLogPath, contents, 'utf8');
    return seq;
  }

  it('stops at the limit: one stop record, later events dropped, file within the limit', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      await fillUntilStopped(eventLog);
      const seqAtStop = eventLog.getEvents().at(-1)?.seq;
      expect(seqAtStop).toBeGreaterThan(0);

      // Every later append resolves, and none of them takes a seq.
      await expect(
        eventLog.append('output', { data: 'x'.repeat(100) }),
      ).resolves.toBe(seqAtStop);
      await expect(
        eventLog.append('input_text', { data: 'typed' }),
      ).resolves.toBe(seqAtStop);
      await expect(
        eventLog.append('resize', { cols: 100, rows: 30 }),
      ).resolves.toBe(seqAtStop);
      await expect(
        eventLog.append('signal', { signal: 'SIGINT' }),
      ).resolves.toBe(seqAtStop);
      await expect(eventLog.append('marker', { label: 'late' })).resolves.toBe(
        seqAtStop,
      );
      expect(
        eventLog.startAppend('input_run', {
          command: 'ls',
          noWait: true,
        }).seq,
      ).toBe(seqAtStop);

      // The exit record still fits in the reserve.
      const exitSeq = await eventLog.append('exit', {
        exitCode: 0,
        exitSignal: null,
      });
      expect(exitSeq).toBe((seqAtStop ?? 0) + 1);
      await expect(eventLog.append('output', { data: 'after' })).resolves.toBe(
        exitSeq,
      );
      await eventLog.readAll();

      const events = eventLog.getEvents();
      expect(stopRecords(eventLog)).toHaveLength(1);
      expect(events.map((event) => event.seq)).toEqual(
        events.map((_, index) => index),
      );
      expect(events.at(-2)).toMatchObject({
        type: 'marker',
        payload: {
          label: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(LIMIT)} bytes); later events are not recorded`,
        },
      });
      expect(events.at(-1)?.type).toBe('exit');
      expect(events.map((event) => event.type)).not.toContain('input_text');
      expect(await fileBytes()).toBeLessThanOrEqual(LIMIT);
    } finally {
      await eventLog.close();
    }
  });

  it('keeps ordinary records out of the tail reserve', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      await fillUntilStopped(eventLog);
      await eventLog.readAll();

      // Everything but the stop record fits below the reserve.
      const stopSeq = eventLog.getEvents().at(-1)?.seq ?? 0;
      const withoutStop = eventLog
        .getEvents()
        .slice(0, stopSeq)
        .reduce(
          (total, event) =>
            total + Buffer.byteLength(`${JSON.stringify(event)}\n`),
          0,
        );
      expect(withoutStop).toBeLessThanOrEqual(
        LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES,
      );
    } finally {
      await eventLog.close();
    }
  });

  it('stops on a single record that is larger than the room', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      await eventLog.append('output', { data: 'prompt$ ' });
      await expect(
        eventLog.append('output', { data: 'x'.repeat(LIMIT) }),
      ).resolves.toBe(1);
      await eventLog.readAll();

      expect(eventLog.getEvents().map((event) => event.type)).toEqual([
        'output',
        'marker',
      ]);
      expect(await fileBytes()).toBeLessThanOrEqual(LIMIT);
    } finally {
      await eventLog.close();
    }
  });

  it('stores nothing after the stop, not even a record that would fit', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      await eventLog.append('output', { data: 'prompt$ ' });
      // About 6000 bytes do not fit in the room below the tail reserve.
      await expect(
        eventLog.append('output', { data: 'x'.repeat(6000) }),
      ).resolves.toBe(1);

      // These are small enough to fit, but the log has stopped.
      await expect(eventLog.append('output', { data: 'ok' })).resolves.toBe(1);
      await expect(
        eventLog.append('input_text', { data: 'typed' }),
      ).resolves.toBe(1);

      await expect(
        eventLog.append('exit', { exitCode: 0, exitSignal: null }),
      ).resolves.toBe(2);
      await eventLog.readAll();

      expect(eventLog.getEvents().map((event) => event.type)).toEqual([
        'output',
        'marker',
        'exit',
      ]);
    } finally {
      await eventLog.close();
    }
  });

  it('counts bytes, not characters, toward the limit', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    // 100 characters of 3 bytes each: a record is about 300 bytes longer than
    // its character count says.
    const block = '█'.repeat(100);

    try {
      for (
        let index = 0;
        index < 100 && stopRecords(eventLog).length === 0;
        index += 1
      ) {
        await eventLog.append('output', { data: block });
      }
      expect(stopRecords(eventLog)).toHaveLength(1);
      await eventLog.append('exit', { exitCode: 0, exitSignal: null });
      await eventLog.readAll();
    } finally {
      await eventLog.close();
    }

    const lines = (await readFile(eventLogPath, 'utf8')).trimEnd().split('\n');
    const byteLength = (text: string): number =>
      Buffer.byteLength(`${text}\n`, 'utf8');
    const stopIndex = lines.findIndex((line) =>
      line.includes(EVENT_LOG_LIMIT_LABEL_PREFIX),
    );
    expect(stopIndex).toBeGreaterThan(0);
    // Ordinary records stay out of the reserve, measured in bytes.
    expect(
      lines
        .slice(0, stopIndex)
        .reduce((sum, line) => sum + byteLength(line), 0),
    ).toBeLessThanOrEqual(LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES);
    expect(await fileBytes()).toBeLessThanOrEqual(LIMIT);
  });

  it('stays stopped when it opens a log that holds its stop record', async () => {
    const first = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    try {
      await first.append('output', { data: 'prompt$ ' });
      // About 6000 bytes do not fit in the room below the tail reserve. The
      // log stops far from the reserve boundary, so a small record would fit.
      await first.append('output', { data: 'x'.repeat(6000) });
      await first.readAll();
      expect(stopRecords(first)).toHaveLength(1);
    } finally {
      await first.close();
    }

    const reopened = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    try {
      // A small record still gets no seq, and the log writes no second stop.
      await expect(reopened.append('output', { data: 'ok' })).resolves.toBe(1);
      await expect(
        reopened.append('input_text', { data: 'typed' }),
      ).resolves.toBe(1);
      // The exit record stays admissible.
      await expect(
        reopened.append('exit', { exitCode: 0, exitSignal: null }),
      ).resolves.toBe(2);
      await reopened.readAll();

      expect(reopened.getEvents().map((event) => event.type)).toEqual([
        'output',
        'marker',
        'exit',
      ]);
      expect(stopRecords(reopened)).toHaveLength(1);
    } finally {
      await reopened.close();
    }

    // A log whose last record is the exit record after the stop also stays
    // stopped.
    const again = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    try {
      await expect(again.append('output', { data: 'ok' })).resolves.toBe(2);
      await again.readAll();
      expect(stopRecords(again)).toHaveLength(1);
    } finally {
      await again.close();
    }

    const stored = await readEventLogRecords(eventLogPath);
    expect(stored.map((event) => event.type)).toEqual([
      'output',
      'marker',
      'exit',
    ]);
  });

  it('does not treat other markers as the stop record when it opens a log', async () => {
    const first = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    try {
      await first.append('output', { data: 'prompt$ ' });
      await first.append('marker', { label: 'checkpoint' });
      // Names the limit, but without the stop record's prefix.
      await first.append('marker', {
        label: 'event log limit reached (8192 bytes)',
      });
    } finally {
      await first.close();
    }

    const reopened = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    try {
      await expect(reopened.append('output', { data: 'ok' })).resolves.toBe(3);
      await reopened.readAll();

      expect(reopened.getEvents().map((event) => event.type)).toEqual([
        'output',
        'marker',
        'marker',
        'output',
      ]);
    } finally {
      await reopened.close();
    }
  });

  it('refuses a log of blank lines that leaves no room for a stop record', async () => {
    // No record, so a dropped append would have no seq to report.
    await writeFile(eventLogPath, '\n'.repeat(LIMIT), 'utf8');
    await expect(
      EventLog.open(eventLogPath, { maxBytes: LIMIT }),
    ).rejects.toThrow(
      `event log ${eventLogPath} holds no record, and its ${String(LIMIT)} bytes leave less than ${String(EVENT_LOG_TAIL_RESERVE_BYTES)} bytes free under the ${String(LIMIT)}-byte limit`,
    );

    await writeFile(
      eventLogPath,
      '\n'.repeat(LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES + 1),
      'utf8',
    );
    await expect(
      EventLog.open(eventLogPath, { maxBytes: LIMIT }),
    ).rejects.toThrow('holds no record');
  });

  it('stops with the stop record as the first record of a log of blank lines up to the reserve', async () => {
    await writeFile(
      eventLogPath,
      '\n'.repeat(LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES),
      'utf8',
    );
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      await expect(
        eventLog.append('output', { data: 'x'.repeat(LIMIT) }),
      ).resolves.toBe(0);
      await expect(
        eventLog.append('exit', { exitCode: 0, exitSignal: null }),
      ).resolves.toBe(1);
      await eventLog.readAll();

      expect(eventLog.getEvents().map((event) => event.type)).toEqual([
        'marker',
        'exit',
      ]);
      expect(await fileBytes()).toBeLessThanOrEqual(LIMIT);
    } finally {
      await eventLog.close();
    }
  });

  it('words the stop record as the docs quote it, for both limits', async () => {
    expect(EVENT_LOG_LIMIT_LABEL_PREFIX).toBe(
      'agent-tty: event log limit reached',
    );

    const bytesLog = await EventLog.open(eventLogPath, { maxBytes: 8192 });
    try {
      await fillUntilStopped(bytesLog);
      expect(stopRecords(bytesLog)).toMatchObject([
        {
          payload: {
            label:
              'agent-tty: event log limit reached (8192 bytes); later events are not recorded',
          },
        },
      ]);
    } finally {
      await bytesLog.close();
    }

    await writeFile(eventLogPath, '', 'utf8');
    const entriesLog = await EventLog.open(eventLogPath, { maxEntries: 20 });
    try {
      for (let index = 0; index < 20; index += 1) {
        await entriesLog.append('output', { data: 'y' });
      }
      expect(stopRecords(entriesLog)).toMatchObject([
        {
          payload: {
            label:
              'agent-tty: event log limit reached (20 events); later events are not recorded',
          },
        },
      ]);
    } finally {
      await entriesLog.close();
    }
  });

  it('counts the size of an existing file toward the limit when it opens', async () => {
    const records = await prefillBytes(
      LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES - 10,
    );
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      // About 80 bytes: it fits an empty file, but not the 10 bytes of room
      // that the existing records leave below the reserve.
      await expect(eventLog.append('output', { data: 'late' })).resolves.toBe(
        records,
      );
      await eventLog.readAll();

      const events = eventLog.getEvents();
      expect(events).toHaveLength(records + 1);
      expect(events.at(-1)).toMatchObject({
        type: 'marker',
        payload: {
          label: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(LIMIT)} bytes); later events are not recorded`,
        },
      });
      expect(await fileBytes()).toBeLessThanOrEqual(LIMIT);
    } finally {
      await eventLog.close();
    }
  });

  it('writes no stop record that would pass the byte limit', async () => {
    // A log that another host filled up to the limit, tail reserve included.
    const records = await prefillBytes(LIMIT - 30);
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      await expect(eventLog.append('output', { data: 'late' })).resolves.toBe(
        records - 1,
      );
      await expect(
        eventLog.append('exit', { exitCode: 0, exitSignal: null }),
      ).resolves.toBe(records - 1);
      await eventLog.readAll();

      expect(eventLog.getEvents()).toHaveLength(records);
      expect(await fileBytes()).toBe(LIMIT - 30);
    } finally {
      await eventLog.close();
    }
  });

  it('keeps a tail reserve that fits the stop record and the largest exit record', () => {
    const lineBytes = (record: object): number =>
      Buffer.byteLength(`${JSON.stringify(record)}\n`);
    // `seq` stays below the entry limit. The host writes an integer exit
    // code and `String(signal)` of a non-negative integer.
    const stop = lineBytes({
      seq: MAX_EVENT_BUFFER_ENTRIES - 2,
      ts: '2026-03-19T12:00:00.000Z',
      type: 'marker',
      payload: {
        label: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(MAX_EVENT_LOG_SIZE)} bytes); later events are not recorded`,
      },
    });
    const exit = lineBytes({
      seq: MAX_EVENT_BUFFER_ENTRIES - 1,
      ts: '2026-03-19T12:00:00.000Z',
      type: 'exit',
      payload: {
        exitCode: -Number.MAX_SAFE_INTEGER,
        exitSignal: String(Number.MAX_SAFE_INTEGER),
      },
    });

    expect(stop + exit).toBeLessThanOrEqual(EVENT_LOG_TAIL_RESERVE_BYTES);
  });

  it('stops at the entry limit: one stop record that names the events', async () => {
    const maxEntries = 20;
    const eventLog = await EventLog.open(eventLogPath, { maxEntries });

    try {
      // Ordinary records fill every entry but the two reserved ones.
      for (let index = 0; index < maxEntries; index += 1) {
        await eventLog.append('output', { data: `line ${String(index)}\r\n` });
      }
      const stopSeq = maxEntries - EVENT_LOG_TAIL_RESERVE_ENTRIES;
      expect(eventLog.getEvents().at(-1)?.seq).toBe(stopSeq);

      await expect(
        eventLog.append('input_text', { data: 'typed' }),
      ).resolves.toBe(stopSeq);
      await expect(
        eventLog.append('resize', { cols: 100, rows: 30 }),
      ).resolves.toBe(stopSeq);
      await expect(eventLog.append('marker', { label: 'late' })).resolves.toBe(
        stopSeq,
      );

      // The exit record still has its entry.
      await expect(
        eventLog.append('exit', { exitCode: 0, exitSignal: null }),
      ).resolves.toBe(stopSeq + 1);
      await expect(eventLog.append('output', { data: 'after' })).resolves.toBe(
        stopSeq + 1,
      );
      await eventLog.readAll();

      const events = eventLog.getEvents();
      expect(events).toHaveLength(maxEntries);
      expect(events.map((event) => event.type)).toEqual([
        ...Array.from({ length: stopSeq }, () => 'output'),
        'marker',
        'exit',
      ]);
      expect(events.at(-2)).toMatchObject({
        payload: {
          label: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(maxEntries)} events); later events are not recorded`,
        },
      });
    } finally {
      await eventLog.close();
    }

    const stored = await readEventLogRecords(eventLogPath);
    expect(stored.map((event) => event.seq)).toEqual(
      stored.map((_, index) => index),
    );
    expect(stored).toHaveLength(maxEntries);
  });

  it('writes the exit record into the entry reserve when the log has not stopped', async () => {
    const maxEntries = 20;
    const eventLog = await EventLog.open(eventLogPath, { maxEntries });

    try {
      for (
        let index = 0;
        index < maxEntries - EVENT_LOG_TAIL_RESERVE_ENTRIES;
        index += 1
      ) {
        await eventLog.append('output', { data: 'y' });
      }
      expect(stopRecords(eventLog)).toHaveLength(0);

      await eventLog.append('exit', { exitCode: 0, exitSignal: null });
      await eventLog.readAll();

      expect(eventLog.getEvents().at(-1)?.type).toBe('exit');
      expect(stopRecords(eventLog)).toHaveLength(0);
    } finally {
      await eventLog.close();
    }
  });

  it('writes no stop record that would pass the entry limit', async () => {
    // A log that another host filled up to the limit, reserve included.
    const maxEntries = 10;
    await prefillEntries(maxEntries);
    const eventLog = await EventLog.open(eventLogPath, { maxEntries });

    try {
      await expect(eventLog.append('output', { data: 'late' })).resolves.toBe(
        maxEntries - 1,
      );
      await expect(
        eventLog.append('exit', { exitCode: 0, exitSignal: null }),
      ).resolves.toBe(maxEntries - 1);
      await eventLog.readAll();

      expect(eventLog.getEvents()).toHaveLength(maxEntries);
    } finally {
      await eventLog.close();
    }
  });

  it('names the byte limit when a record passes both limits', async () => {
    const maxEntries = 10;
    await prefillEntries(maxEntries - EVENT_LOG_TAIL_RESERVE_ENTRIES);
    const eventLog = await EventLog.open(eventLogPath, {
      maxBytes: LIMIT,
      maxEntries,
    });

    try {
      await eventLog.append('output', { data: 'x'.repeat(LIMIT) });
      await eventLog.readAll();

      expect(eventLog.getEvents().at(-1)).toMatchObject({
        type: 'marker',
        payload: {
          label: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (${String(LIMIT)} bytes); later events are not recorded`,
        },
      });
    } finally {
      await eventLog.close();
    }
  });

  it('writes the exit record into the reserve when the log has not stopped', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    const lineBytes = (
      seq: number,
      type: 'output' | 'exit',
      payload: object,
    ): number =>
      Buffer.byteLength(
        `${JSON.stringify({ seq, ts: new Date().toISOString(), type, payload })}\n`,
      );
    const output = { data: 'y'.repeat(20) };
    const exit = { exitCode: 0, exitSignal: null };

    try {
      // Fill the file up to the reserve line, without stopping the log.
      let seq = 0;
      while (
        LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES - (await fileBytes()) >=
        lineBytes(seq, 'output', output)
      ) {
        await eventLog.append('output', output);
        seq += 1;
      }
      expect(
        LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES - (await fileBytes()),
      ).toBeLessThan(lineBytes(seq, 'exit', exit));
      expect(stopRecords(eventLog)).toHaveLength(0);

      await eventLog.append('exit', exit);
      await eventLog.readAll();

      expect(eventLog.getEvents().at(-1)?.type).toBe('exit');
      expect(stopRecords(eventLog)).toHaveLength(0);
      expect(await fileBytes()).toBeGreaterThan(
        LIMIT - EVENT_LOG_TAIL_RESERVE_BYTES,
      );
      expect(await fileBytes()).toBeLessThanOrEqual(LIMIT);
    } finally {
      await eventLog.close();
    }
  });

  it('leaves a log that readers accept and the asciicast export shows the stop', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });

    try {
      await fillUntilStopped(eventLog);
      await eventLog.append('exit', { exitCode: 0, exitSignal: null });
    } finally {
      await eventLog.close();
    }

    const events = await readEventLogRecords(eventLogPath);
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, index) => index),
    );

    const manifest: SessionRecord = {
      version: 1,
      sessionId: 'session-01',
      createdAt: '2026-03-19T12:00:00.000Z',
      updatedAt: '2026-03-19T12:00:00.000Z',
      status: 'exited',
      command: ['/bin/sh'],
      cwd: '/tmp/workspace',
      cols: 80,
      rows: 24,
      hostPid: null,
      childPid: null,
      exitCode: 0,
      exitSignal: null,
    };
    const cast = generateAsciicast('session-01', manifest, events);
    expect(cast.markerCount).toBe(1);
    const markerLine = cast.contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown[])
      .find((line) => line[1] === 'm');
    expect(markerLine?.[2]).toContain(EVENT_LOG_LIMIT_LABEL_PREFIX);
  });

  it('reports a failed write to the caller of a dropped append', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    const eventLogInternals = eventLog as unknown as {
      fileHandle: {
        appendFile: (data: string, encoding: BufferEncoding) => Promise<void>;
      };
      writeQueue: Promise<void>;
    };

    try {
      await fillUntilStopped(eventLog);
      vi.spyOn(eventLogInternals.fileHandle, 'appendFile').mockRejectedValue(
        new Error('EIO'),
      );
      await expect(
        eventLog.append('exit', { exitCode: 0, exitSignal: null }),
      ).rejects.toThrow('EIO');
      await expect(
        eventLog.append('output', { data: 'dropped' }),
      ).rejects.toThrow('EIO');
      vi.restoreAllMocks();
      eventLogInternals.writeQueue = Promise.resolve();
    } finally {
      await eventLog.close();
    }
  });

  it('refuses a limit that readers would not accept or that has no room', async () => {
    await expect(
      EventLog.open(eventLogPath, { maxBytes: MAX_EVENT_LOG_SIZE + 1 }),
    ).rejects.toThrow('maxBytes must leave room');
    await expect(
      EventLog.open(eventLogPath, { maxBytes: EVENT_LOG_TAIL_RESERVE_BYTES }),
    ).rejects.toThrow('maxBytes must leave room');
    await expect(
      EventLog.open(eventLogPath, {
        maxEntries: MAX_EVENT_BUFFER_ENTRIES + 1,
      }),
    ).rejects.toThrow('maxEntries must leave room');
    await expect(
      EventLog.open(eventLogPath, {
        maxEntries: EVENT_LOG_TAIL_RESERVE_ENTRIES,
      }),
    ).rejects.toThrow('maxEntries must leave room');
  });
});
