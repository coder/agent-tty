import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
} from '../helpers.js';

interface FailureEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

describe('backend selection integration', () => {
  let testHome = '';
  let sessionId = '';

  beforeEach(async () => {
    // prettier-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-backend-selection-')));
  });

  afterEach(async () => {
    destroySession(testHome, sessionId);
    await cleanupHome(testHome);
    sessionId = '';
    testHome = '';
  });

  it('accepts --renderer ghostty-web without changing basic CLI behavior', () => {
    const result = runCli(['--renderer', 'ghostty-web', 'doctor', '--json'], {
      AGENT_TTY_HOME: testHome,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });

  it('accepts AGENT_TTY_RENDERER=ghostty-web', () => {
    const result = runCli(['doctor', '--json'], {
      AGENT_TTY_HOME: testHome,
      AGENT_TTY_RENDERER: 'ghostty-web',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });

  it('honors config defaultRenderer during context resolution', async () => {
    await writeFile(
      join(testHome, 'config.json'),
      `${JSON.stringify({ defaultRenderer: 'ghostty-web' })}\n`,
      'utf8',
    );

    const result = runCli(['doctor', '--json'], {
      AGENT_TTY_HOME: testHome,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });

  it('rejects invalid renderer names before backend use', () => {
    const result = runCli(
      ['--renderer', 'not-a-renderer', 'doctor', '--json'],
      { AGENT_TTY_HOME: testHome },
    );

    expect(result.status).not.toBe(0);
    const envelope = JSON.parse(result.stdout) as FailureEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Renderer must be one of: ghostty-web, libghostty-vt.',
    });
  });

  it('threads --renderer ghostty-web through live snapshot RPC paths', () => {
    sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'printf renderer-selection-ready; exec cat',
    ]);

    const result = runCli(
      [
        '--renderer',
        'ghostty-web',
        'snapshot',
        sessionId,
        '--format',
        'structured',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      60_000,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: {
        format: 'structured',
        sessionId,
      },
    });
  });
});
