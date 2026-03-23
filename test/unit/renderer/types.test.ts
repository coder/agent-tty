import { describe, expect, it } from 'vitest';

import {
  ReplayEventSchema,
  ReplayInputSchema,
  RenderProfileConfigSchema,
  ScreenshotResultSchema,
  SemanticSnapshotSchema,
  TextSnapshotSchema,
} from '../../../src/renderer/types.js';

function createReplayEvents() {
  return [
    {
      seq: 0,
      ts: '2026-03-19T12:00:00.000Z',
      type: 'output' as const,
      payload: { data: 'hello' },
    },
    {
      seq: 1,
      ts: '2026-03-19T12:00:01.000Z',
      type: 'resize' as const,
      payload: { cols: 100, rows: 30 },
    },
    {
      seq: 2,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'input_keys' as const,
      payload: { keys: ['Enter'] },
    },
    {
      seq: 3,
      ts: '2026-03-19T12:00:03.000Z',
      type: 'exit' as const,
      payload: { exitCode: 0, exitSignal: null },
    },
  ];
}

describe('renderer schemas', () => {
  it('accepts replay events for every supported event shape', () => {
    const events = [
      {
        seq: 0,
        ts: '2026-03-19T12:00:00.000Z',
        type: 'output',
        payload: { data: 'stdout' },
      },
      {
        seq: 1,
        ts: '2026-03-19T12:00:01.000Z',
        type: 'input_text',
        payload: { data: 'ls' },
      },
      {
        seq: 2,
        ts: '2026-03-19T12:00:02.000Z',
        type: 'input_paste',
        payload: { data: 'echo hi' },
      },
      {
        seq: 3,
        ts: '2026-03-19T12:00:03.000Z',
        type: 'input_keys',
        payload: { keys: ['Ctrl+C'] },
      },
      {
        seq: 4,
        ts: '2026-03-19T12:00:04.000Z',
        type: 'resize',
        payload: { cols: 120, rows: 40 },
      },
      {
        seq: 5,
        ts: '2026-03-19T12:00:05.000Z',
        type: 'marker',
        payload: { label: '' },
      },
      {
        seq: 6,
        ts: '2026-03-19T12:00:06.000Z',
        type: 'signal',
        payload: { signal: 'SIGINT' },
      },
      {
        seq: 7,
        ts: '2026-03-19T12:00:07.000Z',
        type: 'exit',
        payload: { exitCode: 0, exitSignal: null },
      },
    ];

    for (const event of events) {
      expect(ReplayEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('rejects replay events with mismatched payloads', () => {
    const result = ReplayEventSchema.safeParse({
      seq: 0,
      ts: '2026-03-19T12:00:00.000Z',
      type: 'resize',
      payload: { data: 'nope' },
    });

    expect(result.success).toBe(false);
  });

  it('accepts a valid replay input', () => {
    const result = ReplayInputSchema.safeParse({
      sessionId: 'session-01',
      initialCols: 80,
      initialRows: 24,
      events: createReplayEvents(),
      targetSeq: 3,
    });

    expect(result.success).toBe(true);
  });

  it('rejects replay inputs with invalid construction invariants', () => {
    expect(
      ReplayInputSchema.safeParse({
        sessionId: '',
        initialCols: 80,
        initialRows: 24,
        events: createReplayEvents(),
        targetSeq: 3,
      }).success,
    ).toBe(false);
    expect(
      ReplayInputSchema.safeParse({
        sessionId: 'session-01',
        initialCols: 0,
        initialRows: 24,
        events: createReplayEvents(),
        targetSeq: 3,
      }).success,
    ).toBe(false);
    expect(
      ReplayInputSchema.safeParse({
        sessionId: 'session-01',
        initialCols: 80,
        initialRows: 24,
        events: [createReplayEvents()[1], createReplayEvents()[0]],
        targetSeq: 3,
      }).success,
    ).toBe(false);
    expect(
      ReplayInputSchema.safeParse({
        sessionId: 'session-01',
        initialCols: 80,
        initialRows: 24,
        events: createReplayEvents(),
        targetSeq: -1,
      }).success,
    ).toBe(false);
  });

  it('accepts semantic snapshots, text snapshots, screenshots, and profiles', () => {
    expect(
      SemanticSnapshotSchema.safeParse({
        sessionId: 'session-01',
        capturedAtSeq: 3,
        cols: 80,
        rows: 24,
        cursorRow: 2,
        cursorCol: 4,
        isAltScreen: false,
        visibleLines: [
          { row: 0, text: '$ echo hello' },
          { row: 1, text: 'hello' },
        ],
      }).success,
    ).toBe(true);
    expect(
      TextSnapshotSchema.safeParse({
        sessionId: 'session-01',
        capturedAtSeq: 3,
        cols: 80,
        rows: 24,
        cursorRow: 2,
        cursorCol: 4,
        text: '$ echo hello\nhello',
      }).success,
    ).toBe(true);
    expect(
      ScreenshotResultSchema.safeParse({
        sessionId: 'session-01',
        capturedAtSeq: 3,
        profileName: 'reference-dark',
        cols: 80,
        rows: 24,
        artifactPath: '/tmp/screenshot.png',
        pngSizeBytes: 1024,
      }).success,
    ).toBe(true);
    expect(
      RenderProfileConfigSchema.safeParse({
        name: 'custom-profile',
        theme: 'dark',
        fontFamily: 'monospace',
        fontSize: 14,
        cursorStyle: 'block',
        backgroundColor: '#1e1e2e',
        foregroundColor: '#cdd6f4',
      }).success,
    ).toBe(true);
  });

  it('accepts optional scrollback and screenshot metadata fields', () => {
    expect(
      SemanticSnapshotSchema.safeParse({
        sessionId: 'session-01',
        capturedAtSeq: 3,
        cols: 80,
        rows: 24,
        cursorRow: 2,
        cursorCol: 4,
        isAltScreen: false,
        visibleLines: [{ row: 0, text: 'visible' }],
        scrollbackLines: [{ row: 99, text: 'scrollback' }],
      }).success,
    ).toBe(true);
    expect(
      ScreenshotResultSchema.safeParse({
        sessionId: 'session-01',
        capturedAtSeq: 3,
        profileName: 'reference-dark',
        cols: 80,
        rows: 24,
        artifactPath: '/tmp/screenshot.png',
        pngSizeBytes: 1024,
        rendererBackend: 'ghostty-web',
        pixelWidth: 800,
        pixelHeight: 600,
        sha256: 'a'.repeat(64),
        renderProfileHash: 'b'.repeat(64),
      }).success,
    ).toBe(true);
  });

  it('rejects invalid render profile colors', () => {
    const result = RenderProfileConfigSchema.safeParse({
      name: 'broken-profile',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: 'blue',
      foregroundColor: '#cdd6f4',
    });

    expect(result.success).toBe(false);
  });
});
