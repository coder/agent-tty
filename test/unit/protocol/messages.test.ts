import { describe, expect, it } from 'vitest';

import {
  DestroyParamsSchema,
  InspectResultSchema,
  PasteParamsSchema,
  ResizeResultSchema,
  RpcMethodSchemas,
  RpcRequestSchema,
  RpcResponseSchema,
  SendKeysParamsSchema,
  WaitParamsSchema,
  WaitResultSchema,
} from '../../../src/protocol/messages.js';
import {
  EventRecordSchema,
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

  it('rejects an event record with a negative sequence', () => {
    const result = EventRecordSchema.safeParse({
      seq: -1,
      ts: '2026-03-19T12:00:02.000Z',
      type: 'resize',
      payload: {},
    });

    expect(result.success).toBe(false);
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
    });

    expect(result.success).toBe(true);
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

  it('exposes method schemas for every Week 1 RPC method', () => {
    expect(Object.keys(RpcMethodSchemas)).toEqual([
      'inspect',
      'type',
      'paste',
      'sendKeys',
      'resize',
      'signal',
      'wait',
      'destroy',
    ]);
  });
});
