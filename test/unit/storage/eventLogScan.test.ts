import {
  appendFile,
  mkdtemp,
  realpath,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FsPromises from 'node:fs/promises';

import { EventLog } from '../../../src/host/eventLog.js';
import {
  EVENT_LOG_LIMIT_LABEL_PREFIX,
  eventLogStopLabel,
  MAX_EVENT_LOG_SIZE,
  readEventLogRecords,
  scanEventLog,
} from '../../../src/storage/eventLogCodec.js';

// `afterSize` runs right after the scan measures the file, so a test can
// append to the file while the scan is under way, as a live host does.
const hooks = vi.hoisted(() => ({
  afterSize: undefined as undefined | (() => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const measure = handle.stat.bind(handle) as () => Promise<unknown>;
      handle.stat = (async () => {
        const size = await measure();
        await hooks.afterSize?.();
        return size;
      }) as typeof handle.stat;
      return handle;
    },
  };
});

let tempDir = '';
let eventLogPath = '';

function recordLine(
  seq: number,
  type: 'output' | 'marker' | 'exit',
  payload: Record<string, unknown>,
): string {
  return `${JSON.stringify({
    seq,
    ts: '2026-03-19T12:00:00.000Z',
    type,
    payload,
  })}\n`;
}

const stopLine = (seq: number, limit: 'bytes' | 'events' = 'bytes'): string =>
  recordLine(seq, 'marker', {
    label: eventLogStopLabel(limit, limit === 'bytes' ? 8192 : 20),
  });

describe('scanEventLog', () => {
  const LIMIT = 8192;

  beforeEach(async () => {
    hooks.afterSize = undefined;
    // oxfmt-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-event-log-scan-')));
    eventLogPath = join(tempDir, 'events.jsonl');
  });

  afterEach(async () => {
    hooks.afterSize = undefined;
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  /** Stops a log with a real writer, then ends it with the exit record. */
  async function writeStoppedLog(
    options: { maxBytes: number } | { maxEntries: number },
  ): Promise<void> {
    await writeFile(eventLogPath, '', 'utf8');
    const eventLog = await EventLog.open(eventLogPath, options);
    try {
      for (let index = 0; index < 1000; index += 1) {
        await eventLog.append('output', { data: `line ${String(index)}\r\n` });
        if (eventLog.getStop() !== undefined) {
          break;
        }
      }
      await eventLog.append('exit', { exitCode: 0, exitSignal: null });
    } finally {
      await eventLog.close();
    }
  }

  /** Whether `EventLog.open` keeps the file at `eventLogPath` stopped. */
  async function reopenStays(): Promise<'stopped' | 'open'> {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    try {
      const before = eventLog.getEvents().length;
      await eventLog.append('output', { data: 'after the reopen' });
      return eventLog.getEvents().length === before ? 'stopped' : 'open';
    } finally {
      await eventLog.close();
    }
  }

  it('returns undefined when the event log file is missing', async () => {
    await expect(scanEventLog(eventLogPath)).resolves.toBeUndefined();
  });

  it('returns nothing found for an empty event log file', async () => {
    await writeFile(eventLogPath, '', 'utf8');

    await expect(scanEventLog(eventLogPath)).resolves.toEqual({
      entryCount: 0,
      byteCount: 0,
      stop: undefined,
    });
  });

  it('counts non-blank lines, valid or not, and the bytes of the file', async () => {
    const content = [
      JSON.stringify({ seq: 0, type: 'output' }),
      '',
      '   ',
      JSON.stringify({ seq: 1, type: 'resize' }),
    ].join('\n');
    await writeFile(eventLogPath, content, 'utf8');

    await expect(scanEventLog(eventLogPath)).resolves.toEqual({
      entryCount: 2,
      byteCount: Buffer.byteLength(content, 'utf8'),
      stop: undefined,
    });
  });

  it('counts the bytes of the file, not its characters', async () => {
    const content = recordLine(0, 'output', { data: 'héllo ✓ 😀' });
    await writeFile(eventLogPath, content, 'utf8');

    const scan = await scanEventLog(eventLogPath);
    expect(scan?.byteCount).toBe((await stat(eventLogPath)).size);
    expect(scan?.byteCount).toBeGreaterThan(content.length);
  });

  it('rejects empty file paths and rethrows other open errors', async () => {
    await expect(scanEventLog('')).rejects.toThrow();

    // A path whose parent is a regular file raises ENOTDIR, which must
    // propagate: only ENOENT means that there is no log.
    const blocker = join(tempDir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    await expect(
      scanEventLog(join(blocker, 'events.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('returns the byte limit that the writer named, with the seq of its marker', async () => {
    await writeStoppedLog({ maxBytes: LIMIT });

    const records = await readEventLogRecords(eventLogPath);
    const marker = records.at(-2);
    expect(marker?.type).toBe('marker');
    const scan = await scanEventLog(eventLogPath);
    expect(scan).toMatchObject({
      entryCount: records.length,
      stop: { reason: 'bytes', seq: marker?.seq },
    });
  });

  it('returns the event limit that the writer named', async () => {
    await writeStoppedLog({ maxEntries: 20 });

    await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
      entryCount: 20,
      stop: { reason: 'events', seq: 18 },
    });
  });

  it('finds nothing in a log that has not stopped', async () => {
    const eventLog = await EventLog.open(eventLogPath, { maxBytes: LIMIT });
    try {
      await eventLog.append('output', { data: 'hello' });
      await eventLog.append('marker', { label: 'a user marker' });
      await eventLog.append('exit', { exitCode: 0, exitSignal: null });
    } finally {
      await eventLog.close();
    }

    await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
      entryCount: 3,
      stop: undefined,
    });
  });

  it('does not take output or another marker for the stop marker', async () => {
    await writeFile(
      eventLogPath,
      [
        recordLine(0, 'output', {
          data: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (8192 bytes)`,
        }),
        recordLine(1, 'marker', {
          label: 'event log limit reached (8192 bytes)',
        }),
        recordLine(2, 'marker', {
          label: `note: ${EVENT_LOG_LIMIT_LABEL_PREFIX} (8192 bytes)`,
        }),
      ].join(''),
      'utf8',
    );

    await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
      stop: undefined,
    });
  });

  it('returns the first stop marker when a file holds more than one', async () => {
    await writeFile(
      eventLogPath,
      stopLine(0, 'bytes') + stopLine(1, 'events'),
      'utf8',
    );

    await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
      entryCount: 2,
      stop: { reason: 'bytes', seq: 0 },
    });
  });

  it('reports a stop marker that names no limit with the reason unknown instead of failing', async () => {
    await writeFile(
      eventLogPath,
      recordLine(0, 'output', { data: 'x' }) +
        recordLine(1, 'marker', {
          label: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (soon)`,
        }),
      'utf8',
    );

    await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
      stop: { reason: 'unknown', seq: 1 },
    });
    // The host treats the same marker as a stop when it reopens the log.
    expect(await reopenStays()).toBe('stopped');
  });

  it('reads a log that is over the size limit that replay reads', async () => {
    await writeFile(eventLogPath, stopLine(0), 'utf8');
    // Sparse padding: an older version wrote past the limit.
    await truncate(eventLogPath, MAX_EVENT_LOG_SIZE + 1024);

    await expect(readEventLogRecords(eventLogPath)).rejects.toThrow(
      /exceeds size limit/,
    );
    await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
      byteCount: MAX_EVENT_LOG_SIZE + 1024,
      stop: { reason: 'bytes', seq: 0 },
    });
  });

  describe('agrees with what replay accepts', () => {
    const output = (seq: number): string =>
      recordLine(seq, 'output', { data: `line ${String(seq)}` });

    it.each([
      ['a line that is not JSON', `${output(0)}not json\n${stopLine(2)}`],
      [
        'a line that is not an event record',
        `${output(0)}{"seq":1,"type":"nope"}\n${stopLine(2)}`,
      ],
      ['a gap in the seq values', `${output(0)}${stopLine(2)}`],
      ['a repeated seq', `${output(0)}${output(0)}${stopLine(2)}`],
      ['a first seq that is not 0', `${output(1)}${stopLine(2)}`],
    ])('reports no stop for %s before the marker', async (_case, content) => {
      await writeFile(eventLogPath, content, 'utf8');

      // Replay rejects this log, so a stop after the bad line is not one
      // that a replay reaches.
      await expect(readEventLogRecords(eventLogPath)).rejects.toThrow();
      const scan = await scanEventLog(eventLogPath);
      expect(scan?.stop).toBeUndefined();
      // The lines are still counted.
      expect(scan?.entryCount).toBe(content.split('\n').length - 1);
    });

    it('reports the stop of a log that replay accepts', async () => {
      await writeFile(eventLogPath, `${output(0)}${output(1)}${stopLine(2)}`);

      await expect(readEventLogRecords(eventLogPath)).resolves.toHaveLength(3);
      await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
        stop: { reason: 'bytes', seq: 2 },
      });
    });

    it('reports a stop that is followed by a bad line, such as one that is still being written', async () => {
      const marker = stopLine(1);
      await writeFile(
        eventLogPath,
        `${output(0)}${marker}${marker.slice(0, 30)}`,
        'utf8',
      );

      await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
        entryCount: 3,
        stop: { reason: 'bytes', seq: 1 },
      });
    });

    it('reports no stop for a last line that the host has not finished writing', async () => {
      const marker = stopLine(1);
      // Cut inside the label, so the half line still holds the prefix.
      const half = marker.slice(
        0,
        marker.indexOf(EVENT_LOG_LIMIT_LABEL_PREFIX) +
          EVENT_LOG_LIMIT_LABEL_PREFIX.length +
          4,
      );
      await writeFile(eventLogPath, `${output(0)}${half}`, 'utf8');

      await expect(scanEventLog(eventLogPath)).resolves.toMatchObject({
        entryCount: 2,
        stop: undefined,
      });
    });

    it('agrees with EventLog.open on whether a log has stopped', async () => {
      // A stopped log: both see the stop.
      await writeStoppedLog({ maxBytes: LIMIT });
      expect((await scanEventLog(eventLogPath))?.stop).not.toBeUndefined();
      expect(await reopenStays()).toBe('stopped');

      // A log with look-alikes only: neither sees a stop.
      await writeFile(
        eventLogPath,
        recordLine(0, 'output', {
          data: `${EVENT_LOG_LIMIT_LABEL_PREFIX} (8192 bytes)`,
        }) +
          recordLine(1, 'marker', {
            label: 'event log limit reached (8192 bytes)',
          }),
        'utf8',
      );
      expect((await scanEventLog(eventLogPath))?.stop).toBeUndefined();
      expect(await reopenStays()).toBe('open');
    });
  });

  it('describes one snapshot of the file, so records that a live host appends meanwhile are in none of its results', async () => {
    const before = `${recordLine(0, 'output', { data: 'x' })}${recordLine(1, 'output', { data: 'y' })}`;
    await writeFile(eventLogPath, before, 'utf8');
    // The host writes its stop marker right after the scan measured the file.
    hooks.afterSize = async () => {
      hooks.afterSize = undefined;
      await appendFile(eventLogPath, stopLine(2), 'utf8');
    };

    await expect(scanEventLog(eventLogPath)).resolves.toEqual({
      entryCount: 2,
      byteCount: Buffer.byteLength(before, 'utf8'),
      stop: undefined,
    });
    // The next scan sees the marker, as all three results together.
    const next = await scanEventLog(eventLogPath);
    expect(next).toMatchObject({
      entryCount: 3,
      stop: { reason: 'bytes', seq: 2 },
    });
    expect(next?.byteCount).toBe((await stat(eventLogPath)).size);
  });
});
