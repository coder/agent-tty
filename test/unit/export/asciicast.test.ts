import { describe, expect, it } from 'vitest';

import { generateAsciicast } from '../../../src/export/asciicast.js';
import type {
  EventRecord,
  SessionRecord,
} from '../../../src/protocol/schemas.js';

function createManifest(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:00.000Z',
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

function parseAsciicastLines(contents: string): unknown[] {
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

describe('generateAsciicast', () => {
  it('produces a deterministic asciicast with output and resize events', () => {
    const manifest = createManifest();
    const events: EventRecord[] = [
      {
        seq: 0,
        ts: '2026-03-19T12:00:01.000Z',
        type: 'input_text',
        payload: { data: 'ignored input' },
      },
      {
        seq: 1,
        ts: '2026-03-19T12:00:01.250Z',
        type: 'output',
        payload: { data: 'hello' },
      },
      {
        seq: 2,
        ts: '2026-03-19T12:00:02.500Z',
        type: 'resize',
        payload: { cols: 100, rows: 30 },
      },
      {
        seq: 3,
        ts: '2026-03-19T12:00:03.000Z',
        type: 'output',
        payload: { data: 'world\n' },
      },
    ];

    const first = generateAsciicast('session-01', manifest, events);
    const second = generateAsciicast('session-01', manifest, events);
    const lines = parseAsciicastLines(first.contents);

    expect(first.contents).toBe(second.contents);
    expect(first.header).toEqual({
      version: 2,
      width: 80,
      height: 24,
      timestamp: Date.parse('2026-03-19T12:00:01.000Z') / 1000,
      title: 'session-01',
      env: {
        TERM: 'xterm-256color',
      },
    });
    expect(lines).toEqual([
      first.header,
      [0.25, 'o', 'hello'],
      [1.5, 'r', '100x30'],
      [2, 'o', 'world\n'],
    ]);
    expect(first.outputEventCount).toBe(2);
    expect(first.resizeEventCount).toBe(1);
    expect(first.capturedAtSeq).toBe(3);
    expect(first.durationMs).toBe(2000);
  });

  it('produces a header-only cast for empty event logs', () => {
    const manifest = createManifest({
      createdAt: '2026-03-19T12:34:56.000Z',
      cols: 132,
      rows: 40,
    });

    const result = generateAsciicast('session-01', manifest, []);
    const lines = parseAsciicastLines(result.contents);

    expect(lines).toEqual([
      {
        version: 2,
        width: 132,
        height: 40,
        timestamp: Date.parse('2026-03-19T12:34:56.000Z') / 1000,
        title: 'session-01',
        env: {
          TERM: 'xterm-256color',
        },
      },
    ]);
    expect(result.outputEventCount).toBe(0);
    expect(result.resizeEventCount).toBe(0);
    expect(result.capturedAtSeq).toBe(0);
    expect(result.durationMs).toBe(0);
  });
});
