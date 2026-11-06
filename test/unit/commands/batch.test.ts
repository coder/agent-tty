import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BatchResult } from '../../../src/batch/result.js';

import {
  buildBatchLines,
  runBatchCommand,
} from '../../../src/cli/commands/batch.js';

const mocks = vi.hoisted(() => ({
  resolveCommandTarget: vi.fn(),
  sendRpc: vi.fn(),
  emitSuccess: vi.fn(),
  emitFailure: vi.fn(),
  emitSuccessSync: vi.fn(),
}));

vi.mock('../../../src/cli/commandTarget.js', () => ({
  resolveCommandTarget: mocks.resolveCommandTarget,
}));

vi.mock('../../../src/host/rpcClient.js', () => ({
  sendRpc: mocks.sendRpc,
}));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
  emitFailure: mocks.emitFailure,
  emitSuccessSync: mocks.emitSuccessSync,
}));

describe('buildBatchLines', () => {
  it('labels an interrupted step as interrupted, not as a success', () => {
    // The SIGINT/SIGTERM partial flush marks the in-flight step `interrupted`
    // and later steps `not-run`; the human-readable line must not render those
    // as completed/matched (the bug: an interrupted run printed "completed").
    const result: BatchResult = {
      steps: [
        { index: 0, durationMs: 5, kind: 'type', status: 'completed', seq: 1 },
        {
          index: 1,
          durationMs: 0,
          kind: 'run',
          status: 'interrupted',
          noWait: false,
        },
        { index: 2, durationMs: 0, kind: 'wait', status: 'not-run' },
      ],
      completedCount: 1,
      failedIndices: [],
    };

    const lines = buildBatchLines(result);

    expect(lines[0]).toBe('[0] type completed (5ms)');
    expect(lines[1]).toBe('[1] run interrupted (0ms)');
    expect(lines[2]).toBe('[2] wait not-run (0ms)');
    expect(lines.at(-1)).toBe('1/3 steps completed');
  });
});

describe('runBatchCommand when the host reports that its event log stopped', () => {
  const stopNote =
    'The event log stopped at seq 5 (byte limit), so output after it is not seen.';
  const timedOutWait = {
    matched: false,
    timedOut: true,
    capturedAtSeq: 5,
    eventLogStop: { reason: 'bytes', seq: 5 },
  };
  const options = {
    context: {} as Parameters<typeof runBatchCommand>[0]['context'],
    json: true,
    sessionId: 'session-01',
    steps: JSON.stringify([
      { wait: { text: 'one', timeout: 1000 } },
      { wait: { text: 'two', timeout: 1000 } },
    ]),
    keepGoing: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCommandTarget.mockResolvedValue({
      sessionId: 'session-01',
      sessionDirectory: '/tmp/agent-tty/sessions/session-01',
      socketPath: '/tmp/agent-tty/sessions/session-01/rpc.sock',
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('names the stop in every timed-out wait of a --keep-going batch', async () => {
    mocks.sendRpc.mockResolvedValue(timedOutWait);

    await runBatchCommand(options);

    expect(mocks.sendRpc).toHaveBeenCalledTimes(2);
    const methods = (mocks.sendRpc.mock.calls as unknown[][]).map(
      (call) => call[1],
    );
    expect(methods).toEqual(['waitForRender', 'waitForRender']);
    const emitted = mocks.emitSuccess.mock.calls[0] as [
      { result: BatchResult },
    ];
    const { result } = emitted[0];
    expect(result.failedIndices).toEqual([0, 1]);
    expect(
      result.steps.map((step) =>
        step.status === 'failed' ? step.error : undefined,
      ),
    ).toEqual([
      {
        code: 'WAIT_TIMEOUT',
        message: `Render wait at step 0 timed out after 1000 ms. ${stopNote}`,
      },
      {
        code: 'WAIT_TIMEOUT',
        message: `Render wait at step 1 timed out after 1000 ms. ${stopNote}`,
      },
    ]);
  });

  it('names the stop in the error of a failed batch under --json', async () => {
    mocks.sendRpc.mockResolvedValue(timedOutWait);

    await runBatchCommand({ ...options, keepGoing: false });

    expect(mocks.sendRpc).toHaveBeenCalledTimes(1);
    const emitted = mocks.emitFailure.mock.calls[0] as [
      { error: { code: string; message: string } },
    ];
    expect(emitted[0].error).toMatchObject({
      code: 'WAIT_TIMEOUT',
      message: `Render wait at step 0 timed out after 1000 ms. ${stopNote}`,
    });
  });

  it('keeps the message of a timed-out wait when the host reports no stop', async () => {
    mocks.sendRpc.mockResolvedValue({
      matched: false,
      timedOut: true,
      capturedAtSeq: 5,
    });

    await runBatchCommand({ ...options, keepGoing: false });

    const emitted = mocks.emitFailure.mock.calls[0] as [
      { error: { message: string } },
    ];
    expect(emitted[0].error.message).toBe(
      'Render wait at step 0 timed out after 1000 ms.',
    );
  });
});
