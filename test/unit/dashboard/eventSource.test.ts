import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EventRecord } from '../../../src/protocol/schemas.js';
import { EventLogTailSource } from '../../../src/dashboard/eventSource.js';

function outputEvent(seq: number, data: string): EventRecord {
  return {
    seq,
    ts: '2026-06-02T12:00:00.000Z',
    type: 'output',
    payload: { data },
  };
}

function jsonl(records: readonly EventRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

let tempDir = '';
let logPath = '';

describe('EventLogTailSource', () => {
  beforeEach(async () => {
    // oxfmt-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-event-source-')));
    logPath = join(tempDir, 'events.jsonl');
  });

  afterEach(async () => {
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns only newly-appended entries on each poll', async () => {
    const source = new EventLogTailSource(logPath);

    await writeFile(logPath, jsonl([outputEvent(0, 'first')]), 'utf8');
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'first')],
      state: 'active',
    });

    await writeFile(
      logPath,
      jsonl([outputEvent(0, 'first'), outputEvent(1, 'second')]),
      'utf8',
    );
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(1, 'second')],
      state: 'active',
    });

    await expect(source.poll()).resolves.toEqual({
      records: [],
      state: 'active',
    });
  });

  it('buffers a partial trailing line until its terminating newline arrives', async () => {
    const source = new EventLogTailSource(logPath);

    const firstLine = `${JSON.stringify(outputEvent(0, 'first'))}\n`;
    const secondLine = `${JSON.stringify(outputEvent(1, 'second'))}\n`;
    const splitAt = Math.floor(secondLine.length / 2);

    // First record complete, second record only half-written (no newline yet).
    await writeFile(logPath, firstLine + secondLine.slice(0, splitAt), 'utf8');
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'first')],
      state: 'active',
    });

    // The rest of the second line, including its newline, is flushed.
    await appendFile(logPath, secondLine.slice(splitAt), 'utf8');
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(1, 'second')],
      state: 'active',
    });
  });

  it('decodes a multibyte sequence split across two reads without corruption', async () => {
    const source = new EventLogTailSource(logPath);

    const record = outputEvent(0, 'rocket 🚀 done');
    const lineBytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    // Split one byte into the first multibyte (>= 0x80) sequence so a complete
    // character straddles the two reads.
    const splitIndex = lineBytes.findIndex((byte) => byte >= 0x80) + 1;
    expect(splitIndex).toBeGreaterThan(1);

    await writeFile(logPath, lineBytes.subarray(0, splitIndex));
    await expect(source.poll()).resolves.toEqual({
      records: [],
      state: 'active',
    });

    await appendFile(logPath, lineBytes.subarray(splitIndex));
    await expect(source.poll()).resolves.toEqual({
      records: [record],
      state: 'active',
    });
  });

  it('reports a never-created Event Log as pending', async () => {
    const source = new EventLogTailSource(logPath);

    await expect(source.poll()).resolves.toEqual({
      records: [],
      state: 'pending',
    });
  });

  it('reports a removed Event Log as collected after it was active', async () => {
    const source = new EventLogTailSource(logPath);

    await writeFile(logPath, jsonl([outputEvent(0, 'first')]), 'utf8');
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'first')],
      state: 'active',
    });

    await rm(logPath);
    await expect(source.poll()).resolves.toEqual({
      records: [],
      state: 'collected',
    });
  });

  it('resets and re-reads from the start when the log is truncated or rewritten', async () => {
    const source = new EventLogTailSource(logPath);

    await writeFile(
      logPath,
      jsonl([outputEvent(0, 'first'), outputEvent(1, 'second')]),
      'utf8',
    );
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'first'), outputEvent(1, 'second')],
      state: 'active',
    });

    // Rewritten to a smaller file (size < last read offset).
    await writeFile(logPath, jsonl([outputEvent(0, 'restarted')]), 'utf8');
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'restarted')],
      state: 'active',
    });
  });

  it('re-reads a recreated log from the start after it was collected', async () => {
    const source = new EventLogTailSource(logPath);

    await writeFile(logPath, jsonl([outputEvent(0, 'old')]), 'utf8');
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'old')],
      state: 'active',
    });

    await rm(logPath);
    await expect(source.poll()).resolves.toEqual({
      records: [],
      state: 'collected',
    });

    // A brand-new (larger) log appears at the same path; it must be read from
    // the start, not resumed at the previous file's byte offset.
    await writeFile(
      logPath,
      jsonl([outputEvent(0, 'new-a'), outputEvent(1, 'new-b')]),
      'utf8',
    );
    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'new-a'), outputEvent(1, 'new-b')],
      state: 'active',
    });
  });

  it('skips a malformed complete line without dropping the valid records around it', async () => {
    const source = new EventLogTailSource(logPath);

    const content =
      jsonl([outputEvent(0, 'before')]) +
      'this is not json\n' +
      jsonl([outputEvent(1, 'after')]);
    await writeFile(logPath, content, 'utf8');

    await expect(source.poll()).resolves.toEqual({
      records: [outputEvent(0, 'before'), outputEvent(1, 'after')],
      state: 'active',
    });
  });
});
