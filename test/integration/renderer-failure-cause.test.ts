import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
} from '../helpers.js';

const CLI_TIMEOUT_MS = 60_000;
// The fixture makes each ghostty-web replay fail with the error that Playwright
// gives for a RangeError of the page: the cause, then stack frames.
const CAUSE = 'page.evaluate: RangeError: offset is out of bounds';

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

function parseError(stdout: string): ErrorEnvelope['error'] {
  const envelope = JSON.parse(stdout) as ErrorEnvelope;
  expect(envelope.ok).toBe(false);
  return envelope.error;
}

// A failure of the ghostty-web renderer that is not a page crash must name its
// cause in the message of the error, for every command that replays the log of
// a session that has exited.
describe('cause of a ghostty-web failure on an exited session', () => {
  let testHome = '';
  let sessionId = '';
  let env: Record<string, string> = {};

  beforeAll(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-failure-cause-')));
    sessionId = createSession(testHome, ['/bin/sh', '-c', 'echo done']);
    const exited = runCli(
      ['wait', sessionId, '--exit', '--timeout', '20000', '--json'],
      { AGENT_TTY_HOME: testHome },
      CLI_TIMEOUT_MS,
    );
    expect(exited.status).toBe(0);

    const preload = pathToFileURL(
      resolve('test/fixtures/inject-replay-failure.ts'),
    );
    env = {
      AGENT_TTY_HOME: testHome,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS ?? '',
        `--import=${preload.href}`,
      ].join(' '),
      AGENT_TTY_TEST_REPLAY_FAILURE: 'plain',
    };
  }, 120_000);

  afterAll(async () => {
    destroySession(testHome, sessionId);
    await cleanupHome(testHome);
    sessionId = '';
    testHome = '';
  });

  it.each([
    ['snapshot', ['snapshot', '--renderer', 'ghostty-web']],
    ['screenshot', ['screenshot', '--renderer', 'ghostty-web']],
    [
      'wait',
      [
        'wait',
        '--renderer',
        'ghostty-web',
        '--text',
        'NEVER',
        '--timeout',
        '0',
      ],
    ],
  ])(
    'names the cause in the REPLAY_ERROR of an offline %s',
    { timeout: 120_000 },
    (_name, args) => {
      const [command, ...rest] = args;
      const result = runCli(
        [command as string, sessionId, ...rest, '--json'],
        env,
        CLI_TIMEOUT_MS,
      );

      expect(result.status, result.stderr).toBe(10);
      const error = parseError(result.stdout);
      expect(error.code).toBe('REPLAY_ERROR');
      expect(error.retryable).toBe(false);
      // The message ends at the cause: it holds no stack frame.
      expect(error.message).toBe(
        `Failed to boot or replay renderer for session ${sessionId}: ${CAUSE}`,
      );
    },
  );

  it(
    'names the cause in the EXPORT_ERROR of a WebM export',
    { timeout: 120_000 },
    () => {
      const result = runCli(
        [
          'record',
          'export',
          sessionId,
          '--format',
          'webm',
          '--out',
          join(testHome, 'failed.webm'),
          '--json',
        ],
        env,
        CLI_TIMEOUT_MS,
      );

      expect(result.status, result.stderr).toBe(7);
      const error = parseError(result.stdout);
      expect(error.code).toBe('EXPORT_ERROR');
      expect(error.message).toBe(
        `Failed to export session "${sessionId}" as webm: ${CAUSE}`,
      );
    },
  );
});
