import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_CONSECUTIVE_POLL_FAILURES } from '../../src/host/hostMain.js';
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
  parseWaitTimeoutEnvelope,
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

  it('does not match text above the cursor with CLI --scope cursor-line', () => {
    // 'Ready' is printed followed by a newline, so once it is visible the
    // cursor sits on the row below it. A whole-screen wait matches; a
    // cursor-line wait must not — this is the echo-match fix.
    const screenResult = runCli(
      ['wait', sessionId, '--text', 'Ready', '--timeout', '15000', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );
    expect(screenResult.exitCode).toBe(0);

    const cursorLineResult = runCli(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--scope',
        'cursor-line',
        '--timeout',
        '2500',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(cursorLineResult.exitCode).toBe(11);
    const timedOut = parseWaitTimeoutEnvelope(cursorLineResult.stdout);
    expect(timedOut.matched).toBe(false);
    expect(timedOut.timedOut).toBe(true);
  });

  it('matches text on the cursor row with CLI --scope cursor-line', async () => {
    await waitForReadySnapshot(rpcSocketPath);

    // Typing without a newline leaves the echoed text on the cursor row.
    const typeResult = runCli(
      ['type', sessionId, 'CURSOR_TOKEN', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );
    expect(typeResult.exitCode).toBe(0);

    const result = runCli(
      [
        'wait',
        sessionId,
        '--text',
        'CURSOR_TOKEN',
        '--scope',
        'cursor-line',
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
    expect(envelope.result.matchedText).toBe('CURSOR_TOKEN');
  });

  it('rejects invalid CLI --scope values', () => {
    const result = runCli(
      ['wait', sessionId, '--text', 'Ready', '--scope', 'line', '--json'],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.exitCode).not.toBe(0);
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
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

  it('exits 11 with a WAIT_TIMEOUT error envelope that keeps the result when CLI --text times out', () => {
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
    const timedOut = parseWaitTimeoutEnvelope(result.stdout);
    expect(timedOut.matched).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.capturedAtSeq).toBeGreaterThanOrEqual(0);
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.error.details).toEqual({ sessionId, timeoutMs: 1000 });
  });

  it('prints the WAIT_TIMEOUT error to stderr when CLI --text times out without --json', () => {
    const result = runCli(
      ['wait', sessionId, '--text', 'MISSING_TEXT', '--timeout', '1000'],
      { AGENT_TTY_HOME: testHome },
      10_000,
    );

    expect(result.exitCode).toBe(11);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('WAIT_TIMEOUT: Wait timed out after 1000 ms.\n');
  });

  function failingRendererEnv(failures?: number): Record<string, string> {
    const preload = pathToFileURL(
      resolve('test/fixtures/fail-chromium-launch.ts'),
    );
    return {
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS ?? '',
        `--import=${preload.href}`,
      ].join(' '),
      ...(failures === undefined
        ? {}
        : { AGENT_TTY_TEST_CHROMIUM_FAILURES: String(failures) }),
    };
  }

  it.each(['0', '20000'])(
    'returns the renderer error, not WAIT_TIMEOUT, when every render poll fails (--timeout %s)',
    (timeout) => {
      const failingSessionId = createSession(testHome, undefined, {
        env: failingRendererEnv(),
      });
      try {
        const human = runCli(
          [
            '--renderer',
            'ghostty-web',
            'wait',
            failingSessionId,
            '--text',
            'NEVER',
            '--timeout',
            timeout,
          ],
          { AGENT_TTY_HOME: testHome },
          30_000,
        );

        expect(human.exitCode, human.stderr).toBe(9);
        expect(human.stdout).toBe('');
        expect(human.stderr).toMatch(
          /^RPC_ERROR: failed to boot GhosttyWebBackend: .*injected Chromium launch failure/u,
        );

        const json = runCli(
          [
            '--renderer',
            'ghostty-web',
            'wait',
            failingSessionId,
            '--text',
            'NEVER',
            '--timeout',
            timeout,
            '--json',
          ],
          { AGENT_TTY_HOME: testHome },
          30_000,
        );

        expect(json.exitCode, json.stderr).toBe(9);
        const envelope = JSON.parse(json.stdout) as ErrorEnvelope & {
          result?: unknown;
        };
        expect(envelope.error).toMatchObject({
          code: 'RPC_ERROR',
          retryable: true,
        });
        expect(envelope).not.toHaveProperty('result');
      } finally {
        destroySession(testHome, failingSessionId);
      }
    },
  );

  it('keeps the code of a CliError that every render poll throws', () => {
    const preload = pathToFileURL(resolve('test/fixtures/fail-render-poll.ts'));
    const failingSessionId = createSession(testHome, undefined, {
      env: {
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS ?? '',
          `--import=${preload.href}`,
        ].join(' '),
      },
    });
    try {
      const result = runCli(
        [
          'wait',
          failingSessionId,
          '--text',
          'NEVER',
          '--timeout',
          '20000',
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        30_000,
      );

      expect(result.exitCode, result.stderr).toBe(10);
      const envelope = JSON.parse(result.stdout) as ErrorEnvelope & {
        result?: unknown;
      };
      expect(envelope.error).toMatchObject({
        code: 'REPLAY_ERROR',
        message: 'fixture: replay failed',
      });
      expect(envelope).not.toHaveProperty('result');
    } finally {
      destroySession(testHome, failingSessionId);
    }
  });

  // The fixture makes each ghostty-web replay of the host fail and counts the
  // host's calls to its renderer. Each render poll is one call.
  function injectedReplayFailureEnv(
    failure: 'crash' | 'plain',
    renderCallLog: string,
  ): Record<string, string> {
    const preload = pathToFileURL(
      resolve('test/fixtures/inject-replay-failure.ts'),
    );
    return {
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS ?? '',
        `--import=${preload.href}`,
      ].join(' '),
      AGENT_TTY_TEST_REPLAY_FAILURE: failure,
      AGENT_TTY_TEST_RENDER_CALL_LOG: renderCallLog,
    };
  }

  async function countRenderCalls(renderCallLog: string): Promise<number> {
    const text = await readFile(renderCallLog, 'utf8').catch(() => '');
    return text.split('\n').filter((line) => line.length > 0).length;
  }

  it('ends a render wait at the first poll that crashes the ghostty-web page', async () => {
    const renderCallLog = join(testHome, 'crash-render-calls.log');
    const crashedSessionId = createSession(testHome, undefined, {
      env: injectedReplayFailureEnv('crash', renderCallLog),
    });
    try {
      const result = runCli(
        [
          '--renderer',
          'ghostty-web',
          'wait',
          crashedSessionId,
          '--text',
          'NEVER',
          '--timeout',
          '60000',
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        90_000,
      );

      expect(result.exitCode, result.stderr).toBe(10);
      const envelope = JSON.parse(result.stdout) as ErrorEnvelope & {
        result?: unknown;
      };
      expect(envelope.error).toMatchObject({
        code: 'REPLAY_ERROR',
        retryable: false,
      });
      expect(envelope.error.message).toContain(
        "ghostty-web crashed while it replayed this session's output.",
      );
      expect(envelope).not.toHaveProperty('result');
      // The wait does not poll again after the crash.
      expect(await countRenderCalls(renderCallLog)).toBe(1);
    } finally {
      destroySession(testHome, crashedSessionId);
    }
  });

  it('retries a render poll that fails for another reason until the cap', async () => {
    const renderCallLog = join(testHome, 'plain-render-calls.log');
    const failingSessionId = createSession(testHome, undefined, {
      env: injectedReplayFailureEnv('plain', renderCallLog),
    });
    try {
      const result = runCli(
        [
          '--renderer',
          'ghostty-web',
          'wait',
          failingSessionId,
          '--text',
          'NEVER',
          '--timeout',
          '60000',
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        90_000,
      );

      expect(result.exitCode, result.stderr).toBe(9);
      const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
      expect(envelope.error.code).toBe('RPC_ERROR');
      expect(await countRenderCalls(renderCallLog)).toBe(
        MAX_CONSECUTIVE_POLL_FAILURES,
      );
    } finally {
      destroySession(testHome, failingSessionId);
    }
  });

  it('keeps polling through fewer failed render polls than the cap and matches', () => {
    const marker = 'renderer-recovered';
    const recoveringSessionId = createSession(
      testHome,
      ['/bin/sh', '-c', `echo ${marker}; exec cat`],
      { env: failingRendererEnv(3) },
    );
    try {
      const result = runCli(
        [
          '--renderer',
          'ghostty-web',
          'wait',
          recoveringSessionId,
          '--text',
          marker,
          '--timeout',
          '20000',
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        30_000,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        result: { matched: true, timedOut: false },
      });
    } finally {
      destroySession(testHome, recoveringSessionId);
    }
  });

  it('exits 11 with a WAIT_TIMEOUT error envelope when legacy CLI --idle-ms times out', () => {
    const tickingSessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'while :; do echo tick; sleep 0.05; done',
    ]);
    try {
      const result = runCli(
        [
          'wait',
          tickingSessionId,
          '--idle-ms',
          '250',
          '--timeout',
          '1000',
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        10_000,
      );

      expect(result.exitCode).toBe(11);
      expect(result.stderr).toBe('');
      expect(parseWaitTimeoutEnvelope(result.stdout)).toEqual({
        timedOut: true,
      });
    } finally {
      destroySession(testHome, tickingSessionId);
    }
  });

  it('exits 11 with a WAIT_TIMEOUT error envelope when legacy CLI --exit times out', () => {
    const result = runCli(
      ['wait', sessionId, '--exit', '--timeout', '1000', '--json'],
      { AGENT_TTY_HOME: testHome },
      10_000,
    );

    expect(result.exitCode).toBe(11);
    expect(result.stderr).toBe('');
    expect(parseWaitTimeoutEnvelope(result.stdout)).toEqual({
      timedOut: true,
    });
  });

  it.each([
    ['--screen-stable-ms', '5000'],
    ['--idle-ms', '5000'],
  ])(
    'rejects CLI %s %s that cannot finish within --timeout 2000',
    (flag, windowMs) => {
      const result = runCli(
        ['wait', sessionId, flag, windowMs, '--timeout', '2000', '--json'],
        { AGENT_TTY_HOME: testHome },
        10_000,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
      expect(envelope.error.code).toBe('INVALID_DURATION');
      expect(envelope.error.details).toEqual({
        flag,
        windowMs: Number(windowMs),
        timeoutMs: 2000,
      });
    },
  );

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
