import { describe, expect, it } from 'vitest';

import {
  DestroyParamsSchema,
  HostInspectResultSchema,
  InspectResultSchema,
  MarkParamsSchema,
  MarkResultSchema,
  PasteParamsSchema,
  SendKeysResultSchema,
  RecordExportResultSchema,
  ReplayTimingModeSchema,
  ResizeResultSchema,
  RichSnapshotLineSchema,
  RpcMethodSchemas,
  RpcRequestSchema,
  RpcResponseSchema,
  ScreenshotParamsSchema,
  ScreenshotResultSchema,
  SendKeysParamsSchema,
  SnapshotCellSchema,
  SnapshotParamsSchema,
  SnapshotResultSchema,
  TypeParamsSchema,
  WaitForRenderParamsSchema,
  WaitForRenderResultSchema,
  WaitParamsSchema,
  WaitResultSchema,
} from '../../../src/protocol/messages.js';
import {
  EventRecordSchema,
  MarkerEventRecordSchema,
  SessionRecordSchema,
} from '../../../src/protocol/schemas.js';

function createSessionRecord() {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running' as const,
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
  };
}

describe('protocol schemas', () => {
  it('accepts a valid session record', () => {
    const result = SessionRecordSchema.safeParse(createSessionRecord());

    expect(result.success).toBe(true);
  });

  it('accepts a session record with optional create metadata', () => {
    const result = SessionRecordSchema.safeParse({
      ...createSessionRecord(),
      name: 'demo-session',
      env: { FOO: 'bar' },
      term: 'xterm-256color',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a session record with invalid dimensions', () => {
    const result = SessionRecordSchema.safeParse({
      ...createSessionRecord(),
      cols: 0,
    });

    expect(result.success).toBe(false);
  });

  it('accepts a valid event record', () => {
    const result = EventRecordSchema.safeParse({
      seq: 0,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'resize',
      payload: { cols: 120, rows: 40 },
    });

    expect(result.success).toBe(true);
  });

  it('rejects an event record with a mismatched payload shape', () => {
    const result = EventRecordSchema.safeParse({
      seq: 0,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'resize',
      payload: { cols: 120 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an event record with a negative sequence', () => {
    const result = EventRecordSchema.safeParse({
      seq: -1,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'resize',
      payload: { cols: 120, rows: 40 },
    });

    expect(result.success).toBe(false);
  });

  it('accepts marker event records, including empty labels', () => {
    expect(
      MarkerEventRecordSchema.parse({
        seq: 0,
        ts: '2026-03-19T12:00:02.000Z',
        type: 'marker',
        payload: { label: '' },
      }),
    ).toEqual({
      seq: 0,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'marker',
      payload: { label: '' },
    });
    expect(
      MarkerEventRecordSchema.parse({
        seq: 1,
        ts: '2026-03-19T12:00:03.000Z',
        type: 'marker',
        payload: { label: 'Step 1' },
      }),
    ).toEqual({
      seq: 1,
      ts: '2026-03-19T12:00:03.000Z',
      type: 'marker',
      payload: { label: 'Step 1' },
    });
  });
});

describe('RPC message schemas', () => {
  it('accepts a base RPC request', () => {
    const result = RpcRequestSchema.safeParse({
      id: 'request-1',
      method: 'resize',
      params: { cols: 80, rows: 24 },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a request with a non-object params payload', () => {
    const result = RpcRequestSchema.safeParse({
      id: 'request-1',
      method: 'resize',
      params: 'bad',
    });

    expect(result.success).toBe(false);
  });

  it('accepts success and error responses', () => {
    expect(
      RpcResponseSchema.safeParse({
        id: 'request-1',
        ok: true,
        result: {},
      }).success,
    ).toBe(true);
    expect(
      RpcResponseSchema.safeParse({
        id: 'request-1',
        ok: false,
        error: {
          code: 'HOST_TIMEOUT',
          message: 'Session host timed out.',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an error response without a message', () => {
    const result = RpcResponseSchema.safeParse({
      id: 'request-1',
      ok: false,
      error: {
        code: 'HOST_TIMEOUT',
      },
    });

    expect(result.success).toBe(false);
  });

  it('validates inspect results against the session schema', () => {
    const result = InspectResultSchema.safeParse({
      session: createSessionRecord(),
      eventCount: 2,
      uptime: 1000,
    });

    expect(result.success).toBe(true);
  });

  it('keeps inspect RPC results limited to the session payload', () => {
    const result = HostInspectResultSchema.safeParse({
      session: createSessionRecord(),
    });

    expect(result.success).toBe(true);
  });

  it('accepts snapshot params and discriminated snapshot results', () => {
    expect(SnapshotParamsSchema.safeParse({}).success).toBe(true);
    expect(SnapshotParamsSchema.safeParse({ format: 'text' }).success).toBe(
      true,
    );
    expect(
      SnapshotResultSchema.safeParse({
        format: 'structured',
        sessionId: 'session-01',
        capturedAtSeq: 5,
        cols: 80,
        rows: 24,
        cursorRow: 2,
        cursorCol: 4,
        isAltScreen: false,
        visibleLines: [
          {
            row: 0,
            text: 'hello',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      SnapshotResultSchema.safeParse({
        format: 'text',
        sessionId: 'session-01',
        capturedAtSeq: 5,
        cols: 80,
        rows: 24,
        cursorRow: 2,
        cursorCol: 4,
        text: 'hello\nworld',
      }).success,
    ).toBe(true);
  });

  it('rejects snapshot results with invalid discriminants or extra fields', () => {
    expect(
      SnapshotResultSchema.safeParse({
        format: 'structured',
        sessionId: 'session-01',
        capturedAtSeq: 5,
        cols: 80,
        rows: 24,
        cursorRow: 2,
        cursorCol: 4,
        isAltScreen: false,
        visibleLines: [],
        text: 'unexpected',
      }).success,
    ).toBe(false);
    expect(
      SnapshotResultSchema.safeParse({
        format: 'binary',
      }).success,
    ).toBe(false);
  });

  it('accepts screenshot params and results', () => {
    expect(ScreenshotParamsSchema.safeParse({}).success).toBe(true);
    expect(
      ScreenshotParamsSchema.safeParse({ profile: 'reference-dark' }).success,
    ).toBe(true);
    expect(
      ScreenshotResultSchema.safeParse({
        sessionId: 'session-01',
        capturedAtSeq: 5,
        profileName: 'reference-dark',
        cols: 80,
        rows: 24,
        artifactPath: '/tmp/screenshot.png',
        pngSizeBytes: 1024,
      }).success,
    ).toBe(true);
  });

  it('accepts replay timing modes and rich snapshot cell payloads', () => {
    expect(ReplayTimingModeSchema.safeParse('recorded').success).toBe(true);
    expect(ReplayTimingModeSchema.safeParse('accelerated').success).toBe(true);
    expect(ReplayTimingModeSchema.safeParse('max-speed').success).toBe(true);
    expect(ReplayTimingModeSchema.safeParse('slow').success).toBe(false);

    expect(
      SnapshotCellSchema.safeParse({
        char: 'A',
        fg: '#ffffff',
        bg: '#000000',
        bold: true,
        italic: true,
        underline: true,
        strikethrough: false,
      }).success,
    ).toBe(true);
    expect(
      SnapshotCellSchema.safeParse({
        char: 'A',
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      RichSnapshotLineSchema.safeParse({
        lineNumber: 0,
        cells: [
          { char: 'h', fg: '#ffffff' },
          { char: 'i', bold: true },
        ],
      }).success,
    ).toBe(true);
    expect(
      SnapshotResultSchema.safeParse({
        format: 'structured',
        sessionId: 'session-01',
        capturedAtSeq: 5,
        cols: 80,
        rows: 24,
        cursorRow: 2,
        cursorCol: 4,
        isAltScreen: false,
        visibleLines: [{ row: 0, text: 'hi' }],
        cells: [
          {
            lineNumber: 0,
            cells: [{ char: 'h' }, { char: 'i', underline: true }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts optional snapshot flags and screenshot metadata fields', () => {
    expect(
      SnapshotParamsSchema.safeParse({
        includeScrollback: true,
        includeCells: true,
      }).success,
    ).toBe(true);
    expect(
      SnapshotResultSchema.safeParse({
        format: 'structured',
        sessionId: 'session-01',
        capturedAtSeq: 5,
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
        capturedAtSeq: 5,
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

  it('rejects empty screenshot profile names', () => {
    expect(ScreenshotParamsSchema.safeParse({ profile: '' }).success).toBe(
      false,
    );
  });

  it('accepts screenshot profiles at the maximum length', () => {
    expect(
      ScreenshotParamsSchema.safeParse({ profile: 'x'.repeat(100) }).success,
    ).toBe(true);
  });

  it('rejects screenshot profiles beyond the maximum length', () => {
    expect(
      ScreenshotParamsSchema.safeParse({ profile: 'x'.repeat(101) }).success,
    ).toBe(false);
  });

  it('accepts waitForRender text and regex at their maximum lengths', () => {
    expect(
      WaitForRenderParamsSchema.safeParse({ text: 'x'.repeat(1000) }).success,
    ).toBe(true);
    expect(
      WaitForRenderParamsSchema.safeParse({ regex: 'x'.repeat(200) }).success,
    ).toBe(true);
  });

  it('rejects waitForRender text and regex beyond their maximum lengths', () => {
    expect(
      WaitForRenderParamsSchema.safeParse({ text: 'x'.repeat(1001) }).success,
    ).toBe(false);
    expect(
      WaitForRenderParamsSchema.safeParse({ regex: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('accepts waitForRender params for text, regex, stable-screen, and cursor waits', () => {
    expect(
      WaitForRenderParamsSchema.safeParse({ text: 'Ready', timeoutMs: 1000 })
        .success,
    ).toBe(true);
    expect(
      WaitForRenderParamsSchema.safeParse({ regex: 'Ready|Done' }).success,
    ).toBe(true);
    expect(
      WaitForRenderParamsSchema.safeParse({ screenStableMs: 250 }).success,
    ).toBe(true);
    expect(
      WaitForRenderParamsSchema.safeParse({ cursorRow: 0, cursorCol: 5 })
        .success,
    ).toBe(true);
  });

  it('rejects invalid waitForRender params', () => {
    expect(WaitForRenderParamsSchema.safeParse({}).success).toBe(false);
    expect(
      WaitForRenderParamsSchema.safeParse({
        text: 'Ready',
        regex: 'Done',
      }).success,
    ).toBe(false);
    expect(
      WaitForRenderParamsSchema.safeParse({ screenStableMs: 0 }).success,
    ).toBe(false);
    expect(WaitForRenderParamsSchema.safeParse({ cursorRow: -1 }).success).toBe(
      false,
    );
    expect(WaitForRenderParamsSchema.safeParse({ cursorCol: -1 }).success).toBe(
      false,
    );
  });

  it('accepts waitForRender results with replay metadata', () => {
    expect(
      WaitForRenderResultSchema.safeParse({
        matched: true,
        timedOut: false,
        matchedText: 'Ready',
        cursorRow: 3,
        cursorCol: 4,
        capturedAtSeq: 7,
      }).success,
    ).toBe(true);
  });

  it('accepts valid record export results', () => {
    expect(
      RecordExportResultSchema.safeParse({
        sessionId: 'session-01',
        format: 'asciicast',
        artifactPath: '/tmp/session-01/artifacts/recording-7-asciicast.cast',
        bytes: 4096,
        sha256: 'abc123',
        capturedAtSeq: 7,
        durationMs: 2500,
        metadata: {
          rows: 24,
          cols: 80,
        },
      }).success,
    ).toBe(true);
    expect(
      RecordExportResultSchema.safeParse({
        sessionId: 'session-01',
        format: 'webm',
        artifactPath: '/tmp/session-01/artifacts/recording-7-webm.json',
        bytes: 4096,
        sha256: 'abc123',
        capturedAtSeq: 7,
        metadata: {},
      }).success,
    ).toBe(true);
  });

  it('rejects invalid record export results', () => {
    expect(
      RecordExportResultSchema.safeParse({
        sessionId: 'session-01',
        format: 'asciicast',
        artifactPath: '/tmp/session-01/artifacts/recording-7-asciicast.cast',
        bytes: 0,
        sha256: 'abc123',
        capturedAtSeq: 7,
        metadata: {},
      }).success,
    ).toBe(false);
    expect(
      RecordExportResultSchema.safeParse({
        sessionId: 'session-01',
        format: 'asciicast-v2',
        artifactPath: '/tmp/session-01/artifacts/recording-7-asciicast.cast',
        bytes: 4096,
        sha256: 'abc123',
        capturedAtSeq: 7,
        metadata: {},
      }).success,
    ).toBe(false);
    expect(
      RecordExportResultSchema.safeParse({
        sessionId: 'session-01',
        format: 'asciicast',
        artifactPath: '/tmp/session-01/artifacts/recording-7-asciicast.cast',
        bytes: 4096,
        sha256: 'abc123',
        capturedAtSeq: 7,
        metadata: {},
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('rejects empty key arrays for sendKeys', () => {
    const result = SendKeysParamsSchema.safeParse({
      keys: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty paste text', () => {
    const result = PasteParamsSchema.safeParse({
      text: '',
    });

    expect(result.success).toBe(false);
  });

  it('accepts mark params with empty labels and mark results with seq values', () => {
    expect(MarkParamsSchema.parse({ label: '' })).toEqual({ label: '' });
    expect(MarkResultSchema.parse({ seq: 42 })).toEqual({ seq: 42 });
  });

  it('accepts sendKeys results with accepted keys, bytes written, and seq', () => {
    expect(
      SendKeysResultSchema.parse({
        accepted: ['Enter'],
        bytesWritten: 1,
        seq: 42,
      }),
    ).toEqual({
      accepted: ['Enter'],
      bytesWritten: 1,
      seq: 42,
    });
  });

  it('rejects empty type text', () => {
    const result = TypeParamsSchema.safeParse({
      text: '',
    });

    expect(result.success).toBe(false);
  });

  it('rejects zero-valued wait durations', () => {
    expect(
      WaitParamsSchema.safeParse({
        idleMs: 0,
      }).success,
    ).toBe(false);
    expect(
      WaitParamsSchema.safeParse({
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });

  it('accepts resize results with positive dimensions', () => {
    const result = ResizeResultSchema.safeParse({
      cols: 120,
      rows: 40,
    });

    expect(result.success).toBe(true);
  });

  it('rejects resize results without positive dimensions', () => {
    expect(ResizeResultSchema.safeParse({}).success).toBe(false);
    expect(
      ResizeResultSchema.safeParse({
        cols: 0,
        rows: 40,
      }).success,
    ).toBe(false);
  });

  it('rejects invalid wait result exit codes', () => {
    const result = WaitResultSchema.safeParse({
      exitCode: 2.5,
      timedOut: false,
    });

    expect(result.success).toBe(false);
  });

  it('accepts destroy params with an optional force flag', () => {
    expect(DestroyParamsSchema.safeParse({}).success).toBe(true);
    expect(DestroyParamsSchema.safeParse({ force: true }).success).toBe(true);
  });

  it('exposes method schemas for every RPC method', () => {
    expect(Object.keys(RpcMethodSchemas)).toEqual([
      'inspect',
      'snapshot',
      'screenshot',
      'type',
      'paste',
      'mark',
      'sendKeys',
      'resize',
      'signal',
      'wait',
      'waitForRender',
      'destroy',
    ]);
  });
});
