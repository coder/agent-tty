import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '../../../src/host/eventLog.js';

let tempDir = '';
let eventLogPath = '';

describe('EventLog', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-terminal-event-log-'));
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

  it('readAll rejects gaps in stored sequence numbers', async () => {
    const eventLog = await EventLog.open(eventLogPath);

    try {
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

      await expect(eventLog.readAll()).rejects.toThrow(
        'event log seq values must increase by 1 without gaps',
      );
    } finally {
      await eventLog.close();
    }
  });
});
