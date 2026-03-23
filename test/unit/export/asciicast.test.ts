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

    const first = generateAsciicast(
      'session-01',
      manifest,
      events,
      '0.1.0-test',
    );
    const second = generateAsciicast(
      'session-01',
      manifest,
      events,
      '0.1.0-test',
    );
    const lines = parseAsciicastLines(first.contents);

    expect(first.contents).toBe(second.contents);
    expect(first.header).toEqual({
      version: 2,
      width: 80,
      height: 24,
      timestamp: Date.parse('2026-03-19T12:00:01.000Z') / 1000,
      title: 'session-01',
      sessionId: 'session-01',
      toolVersion: '0.1.0-test',
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
    expect(first.markerCount).toBe(0);
    expect(first.capturedAtSeq).toBe(3);
    expect(first.durationMs).toBe(2000);
  });

  it('includes sessionId and omits toolVersion when not provided', () => {
    const manifest = createManifest();

    const result = generateAsciicast('session-01', manifest, []);
    const [headerLine] = parseAsciicastLines(result.contents) as [
      Record<string, unknown>,
    ];

    expect(headerLine).toMatchObject({
      version: 2,
      title: 'session-01',
      sessionId: 'session-01',
    });
    expect(headerLine).not.toHaveProperty('toolVersion');
  });

  it('emits marker events as m lines in chronological order', () => {
    const manifest = createManifest();
    const events: EventRecord[] = [
      {
        seq: 0,
        ts: '2026-03-19T12:00:01.000Z',
        type: 'output',
        payload: { data: 'booting' },
      },
      {
        seq: 1,
        ts: '2026-03-19T12:00:01.500Z',
        type: 'marker',
        payload: { label: 'checkpoint' },
      },
      {
        seq: 2,
        ts: '2026-03-19T12:00:02.000Z',
        type: 'resize',
        payload: { cols: 100, rows: 30 },
      },
      {
        seq: 3,
        ts: '2026-03-19T12:00:02.500Z',
        type: 'marker',
        payload: { label: '' },
      },
      {
        seq: 4,
        ts: '2026-03-19T12:00:03.000Z',
        type: 'output',
        payload: { data: 'ready\n' },
      },
    ];

    const result = generateAsciicast('session-01', manifest, events);

    expect(parseAsciicastLines(result.contents)).toEqual([
      result.header,
      [0, 'o', 'booting'],
      [0.5, 'm', 'checkpoint'],
      [1, 'r', '100x30'],
      [1.5, 'm', ''],
      [2, 'o', 'ready\n'],
    ]);
    expect(result.outputEventCount).toBe(2);
    expect(result.resizeEventCount).toBe(1);
    expect(result.markerCount).toBe(2);
    expect(result.capturedAtSeq).toBe(4);
    expect(result.durationMs).toBe(2000);
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
        sessionId: 'session-01',
        env: {
          TERM: 'xterm-256color',
        },
      },
    ]);
    expect(result.outputEventCount).toBe(0);
    expect(result.resizeEventCount).toBe(0);
    expect(result.markerCount).toBe(0);
    expect(result.capturedAtSeq).toBe(0);
    expect(result.durationMs).toBe(0);
  });
});
