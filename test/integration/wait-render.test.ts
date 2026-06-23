import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendRpc } from '../../src/host/rpcClient.js';
import type {
  SnapshotResult,
  WaitForRenderResult,
} from '../../src/protocol/messages.js';
import { sessionDir, socketPath } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createSession,
  destroySession,
  readEvents,
  runCli,
  sleep,
  type SuccessEnvelope,
  type WaitResult,
} from '../helpers.js';

const SESSION_COMMAND = [
  '/bin/sh',
  '-c',
  "printf 'booting\\n'; sleep 1; printf '3 items\\n'; sleep 1; printf 'Ready\\n'; exec cat",
] as const;
const HOOK_TIMEOUT_MS = 30_000;

interface ErrorEnvelope {
  ok: false;
  command: string;
  timestamp: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

async function waitForOutputMarker(
  testHome: string,
  sessionId: string,
  marker: string,
): Promise<void> {
  const waitResult = runCli(
    ['wait', sessionId, '--idle-ms', '200', '--timeout', '10000', '--json'],
    { AGENT_TTY_HOME: testHome },
    15_000,
  );

  expect(waitResult.status).toBe(0);
  expect(waitResult.stderr).toBe('');
  const waitEnvelope = JSON.parse(
    waitResult.stdout,
  ) as SuccessEnvelope<WaitResult>;
  expect(waitEnvelope.ok).toBe(true);
  expect(waitEnvelope.result.timedOut).toBe(false);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = await readEvents(testHome, sessionId).catch(() => []);
    const output = events
      .filter((event) => event.type === 'output')
      .map((event) => {
        const data = event.payload.data;
        return typeof data === 'string' ? data : '';
      })
      .join('');

    if (output.includes(marker)) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`timed out waiting for output marker ${marker}`);
}

type StructuredSnapshot = Extract<SnapshotResult, { format: 'structured' }>;

async function waitForReadySnapshot(
  rpcSocketPath: string,
): Promise<StructuredSnapshot> {
  await sendRpc(
    rpcSocketPath,
    'waitForRender',
    { text: 'Ready', timeoutMs: 15_000 },
    20_000,
  );

  return (await sendRpc(
    rpcSocketPath,
    'snapshot',
    { format: 'structured' },
    20_000,
  )) as StructuredSnapshot;
}

describe('wait render integration', { timeout: 120_000 }, () => {
  let testHome = '';
  let sessionId = '';
  let rpcSocketPath = '';

  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-wait-render-')));
    sessionId = createSession(testHome, [...SESSION_COMMAND]);
    await waitForOutputMarker(testHome, sessionId, 'booting');

    const sessDir = sessionDir(testHome, sessionId);
    rpcSocketPath = socketPath(sessDir);
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    destroySession(testHome, sessionId);
    await cleanupHome(testHome);
    sessionId = '';
    rpcSocketPath = '';
    testHome = '';
  }, HOOK_TIMEOUT_MS);

  it('rejects unsafe regexes through direct waitForRender RPC', async () => {
    const promise = sendRpc(
      rpcSocketPath,
      'waitForRender',
      { regex: '(a+)+', timeoutMs: 5_000 },
      10_000,
    );

    await expect(promise).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(promise).rejects.toHaveProperty(
      'message',
      expect.stringContaining('nested quantifiers'),
    );
  });

  it('matches text via waitForRender RPC', async () => {
    const result = (await sendRpc(
      rpcSocketPath,
      'waitForRender',
      { text: 'Ready', timeoutMs: 15_000 },
      20_000,
    )) as WaitForRenderResult;

    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.matchedText).toBe('Ready');
    expect(result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('matches regex via waitForRender RPC', async () => {
    const result = (await sendRpc(
      rpcSocketPath,
      'waitForRender',
      { regex: '\\d+ items', timeoutMs: 15_000 },
      20_000,
    )) as WaitForRenderResult;

    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.matchedText).toBe('3 items');
    expect(result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('matches cursor position via waitForRender RPC', async () => {
    const snapshot = await waitForReadySnapshot(rpcSocketPath);

    const result = (await sendRpc(
      rpcSocketPath,
      'waitForRender',
      {
        cursorRow: snapshot.cursorRow,
        cursorCol: snapshot.cursorCol,
        timeoutMs: 5_000,
      },
      10_000,
    )) as WaitForRenderResult;

    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.cursorRow).toBe(snapshot.cursorRow);
    expect(result.cursorCol).toBe(snapshot.cursorCol);
    expect(result.capturedAtSeq).toBeGreaterThanOrEqual(snapshot.capturedAtSeq);
  });

  it('matches text and cursor row together via waitForRender RPC', async () => {
    const snapshot = await waitForReadySnapshot(rpcSocketPath);

    const result = (await sendRpc(
      rpcSocketPath,
      'waitForRender',
      {
        text: 'Ready',
        cursorRow: snapshot.cursorRow,
        timeoutMs: 5_000,
      },
      10_000,
    )) as WaitForRenderResult;

    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.matchedText).toBe('Ready');
    expect(result.cursorRow).toBe(snapshot.cursorRow);
    expect(result.cursorCol).toBe(snapshot.cursorCol);
  });

  it('times out when text is not found', async () => {
    const result = (await sendRpc(
      rpcSocketPath,
      'waitForRender',
      { text: 'MISSING_TEXT', timeoutMs: 2_000 },
      10_000,
    )) as WaitForRenderResult;

    expect(result.matched).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('detects screen stability via waitForRender RPC', async () => {
    await sendRpc(
      rpcSocketPath,
      'waitForRender',
      { text: 'Ready', timeoutMs: 15_000 },
      20_000,
    );

    const result = (await sendRpc(
      rpcSocketPath,
      'waitForRender',
      { screenStableMs: 1_000, timeoutMs: 10_000 },
      15_000,
    )) as WaitForRenderResult;

    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('matches text AND screen stability together', async () => {
    await sendRpc(
      rpcSocketPath,
      'waitForRender',
      { regex: '\\d+ items', timeoutMs: 15_000 },
      20_000,
    );

    const result = (await sendRpc(
      rpcSocketPath,
      'waitForRender',
      { text: 'Ready', screenStableMs: 500, timeoutMs: 15_000 },
      20_000,
    )) as WaitForRenderResult;

    expect(result.matched).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.matchedText).toBe('Ready');
    expect(result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('matches text via CLI --text', () => {
    const result = runCli(
      ['wait', sessionId, '--text', 'Ready', '--timeout', '15000', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.matchedText).toBe('Ready');
  });

  it('matches regex via CLI --regex', () => {
    const result = runCli(
      [
        'wait',
        sessionId,
        '--regex',
        '\\d+ items',
        '--timeout',
        '15000',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.matchedText).toBe('3 items');
  });

  it('detects screen stability via CLI --screen-stable-ms', () => {
    const readyResult = runCli(
      ['wait', sessionId, '--text', 'Ready', '--timeout', '15000', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(readyResult.exitCode).toBe(0);
    expect(readyResult.stderr).toBe('');

    const result = runCli(
      [
        'wait',
        sessionId,
        '--screen-stable-ms',
        '1000',
        '--timeout',
        '10000',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.matchedText).toBeUndefined();
    expect(envelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('matches cursor position via CLI --cursor-row/--cursor-col', async () => {
    const snapshot = await waitForReadySnapshot(rpcSocketPath);

    const result = runCli(
      [
        'wait',
        sessionId,
        '--cursor-row',
        String(snapshot.cursorRow),
        '--cursor-col',
        String(snapshot.cursorCol),
        '--timeout',
        '5000',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      10_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.cursorRow).toBe(snapshot.cursorRow);
    expect(envelope.result.cursorCol).toBe(snapshot.cursorCol);
  });

  it('exits 11 with a success envelope when CLI --text times out', () => {
    const result = runCli(
      [
        'wait',
        sessionId,
        '--text',
        'MISSING_TEXT',
        '--timeout',
        '1000',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      10_000,
    );

    expect(result.exitCode).toBe(11);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(false);
    expect(envelope.result.timedOut).toBe(true);
    expect(envelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('exits 11 with a success envelope when legacy CLI --idle-ms times out', () => {
    const result = runCli(
      ['wait', sessionId, '--idle-ms', '10000', '--timeout', '1000', '--json'],
      { AGENT_TTY_HOME: testHome },
      10_000,
    );

    expect(result.exitCode).toBe(11);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<WaitResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.timedOut).toBe(true);
  });

  it('exits 11 with a success envelope when legacy CLI --exit times out', () => {
    const result = runCli(
      ['wait', sessionId, '--exit', '--timeout', '1000', '--json'],
      { AGENT_TTY_HOME: testHome },
      10_000,
    );

    expect(result.exitCode).toBe(11);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<WaitResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.timedOut).toBe(true);
  });

  it('rejects non-integer CLI --cursor-row values', () => {
    const result = runCli(
      ['wait', sessionId, '--cursor-row', '1.5', '--json'],
      { AGENT_TTY_HOME: testHome },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain('--cursor-row');
    expect(envelope.error.message).toContain('non-negative integer');
  });

  it('rejects negative CLI --cursor-col values', () => {
    const result = runCli(['wait', sessionId, '--cursor-col', '-1', '--json'], {
      AGENT_TTY_HOME: testHome,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain('--cursor-col');
    expect(envelope.error.message).toContain('non-negative integer');
  });

  it('rejects mixing --exit with --text', () => {
    const result = runCli(
      ['wait', sessionId, '--exit', '--text', 'Ready', '--json'],
      { AGENT_TTY_HOME: testHome },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain('Cannot mix');
  });

  it('rejects --text and --regex together', () => {
    const result = runCli(
      ['wait', sessionId, '--text', 'foo', '--regex', 'bar', '--json'],
      { AGENT_TTY_HOME: testHome },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('legacy wait --idle-ms still works', () => {
    const result = runCli(
      ['wait', sessionId, '--idle-ms', '300', '--timeout', '10000', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<WaitResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
  });

  it('legacy wait --exit still works', () => {
    const shortSessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'echo done; exit 0',
    ]);
    const result = runCli(
      ['wait', shortSessionId, '--exit', '--timeout', '10000', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<WaitResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
  });
});
