import { describe, expect, it } from 'vitest';

import { buildReplayInput } from '../../../src/host/replay.js';
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

function createEventsWithMarker(): EventRecord[] {
  return [
    {
      seq: 0,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'output',
      payload: { data: 'hello' },
    },
    {
      seq: 1,
      ts: '2026-03-19T12:00:02.500Z',
      type: 'marker',
      payload: { label: 'checkpoint' },
    },
    {
      seq: 2,
      ts: '2026-03-19T12:00:03.000Z',
      type: 'resize',
      payload: { cols: 100, rows: 30 },
    },
  ];
}

describe('replay helpers', () => {
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

  it('buildReplayInput preserves marker events', () => {
    const events = createEventsWithMarker();
    const replayInput = buildReplayInput(
      'session-01',
      createManifest(),
      events,
    );

    expect(replayInput.events).toEqual(events);
    expect(replayInput.events[1]).toEqual({
      seq: 1,
      ts: '2026-03-19T12:00:02.500Z',
      type: 'marker',
      payload: { label: 'checkpoint' },
    });
    expect(replayInput.targetSeq).toBe(2);
  });

  it('buildReplayInput prefers creation-time dimensions when present', () => {
    const replayInput = buildReplayInput(
      'session-01',
      createManifest({
        cols: 100,
        rows: 30,
        creationCols: 80,
        creationRows: 24,
      }),
      createEvents(),
    );

    expect(replayInput.initialCols).toBe(80);
    expect(replayInput.initialRows).toBe(24);
  });

  it('buildReplayInput falls back to current dimensions for legacy manifests', () => {
    const replayInput = buildReplayInput(
      'session-01',
      createManifest({ cols: 100, rows: 30 }),
      createEvents(),
    );

    expect(replayInput.initialCols).toBe(100);
    expect(replayInput.initialRows).toBe(30);
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
    ).toThrow('event log seq values must increase by 1 without gaps');
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

  it('buildReplayInput trusted path returns equal result to default path', () => {
    const base = buildReplayInput(
      'session-01',
      createManifest(),
      createEvents(),
    );
    const trusted = buildReplayInput(
      'session-01',
      createManifest(),
      createEvents(),
      undefined,
      { trustValidated: true },
    );
    expect(trusted).toEqual(base);
  });

  it('buildReplayInput trusted path returns a fresh array not aliasing the input', () => {
    const input = createEvents();
    const result = buildReplayInput(
      'session-01',
      createManifest(),
      input,
      undefined,
      { trustValidated: true },
    );
    expect(result.events).not.toBe(input); // fresh array — does not alias the live buffer
    expect(result.events).toEqual(input); // same contents
  });

  it('buildReplayInput trusted path still enforces targetSeq invariants', () => {
    expect(() =>
      buildReplayInput('session-01', createManifest(), createEvents(), 5, {
        trustValidated: true,
      }),
    ).toThrow('targetSeq must not exceed the last event seq');
  });

  it('buildReplayInput trusted path intentionally skips contiguity validation', () => {
    const nonContiguous: EventRecord[] = [
      {
        seq: 0,
        ts: '2026-03-19T12:00:02.000Z',
        type: 'output',
        payload: { data: 'a' },
      },
      {
        seq: 3,
        ts: '2026-03-19T12:00:03.000Z',
        type: 'output',
        payload: { data: 'b' },
      },
    ];
    expect(() =>
      buildReplayInput('session-01', createManifest(), nonContiguous),
    ).toThrow('event log seq values must increase by 1 without gaps'); // default: validated
    expect(
      buildReplayInput('session-01', createManifest(), nonContiguous, 3, {
        trustValidated: true,
      }).events,
    ).toHaveLength(2); // trusted: accepted as-is
  });
});
