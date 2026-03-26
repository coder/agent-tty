import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  readEvents,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';
import type { CommandErrorEnvelope } from '../../src/protocol/envelope.js';

let testHome = '';
let sessionId = '';

function testEnv(): Record<string, string> {
  return { AGENT_TERMINAL_HOME: testHome };
}

describe('run command integration', { timeout: 45_000 }, () => {
  beforeEach(() => {
    // prettier-ignore
    testHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-terminal-run-home-')));
  });

  afterEach(async () => {
    destroySession(testHome, sessionId);
    sessionId = '';
    await cleanupHome(testHome);
    testHome = '';
  });

  it('returns SESSION_NOT_FOUND for missing session', () => {
    const result = runCli(
      ['run', 'nonexistent', 'echo hello', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as CommandErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('returns immediately with --no-wait', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(500);

    const result = runCli(
      ['run', sessionId, 'echo hello', '--no-wait', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
      accepted: true;
      seq: number;
    }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.accepted).toBe(true);
    expect(envelope.result.seq).toBeTypeOf('number');
    expect(envelope.result.seq).toBeGreaterThanOrEqual(0);
    expect(envelope.result).not.toHaveProperty('completed');
    expect(envelope.result).not.toHaveProperty('timedOut');
    expect(envelope.result).not.toHaveProperty('durationMs');
    expect(envelope.result).not.toHaveProperty('marker');
  });

  it('reads command from --file', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(500);

    const scriptPath = join(testHome, 'test-script.sh');
    writeFileSync(scriptPath, 'echo from-file');

    const result = runCli(
      ['run', sessionId, '--file', scriptPath, '--no-wait', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
      accepted: true;
      seq: number;
    }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.accepted).toBe(true);
  });

  it('rejects inline text and --file together', () => {
    const scriptPath = join(testHome, 'test-input.txt');
    writeFileSync(scriptPath, 'echo hello');

    const result = runCli(
      ['run', 'some-session', 'inline-text', '--file', scriptPath, '--json'],
      testEnv(),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as CommandErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('records input_run event in the event log', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(500);

    const result = runCli(
      ['run', sessionId, 'echo event-test', '--no-wait', '--json'],
      testEnv(),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    await sleep(200);

    const events = await readEvents(testHome, sessionId);
    const inputRunEvents = events.filter((event) => event.type === 'input_run');
    expect(inputRunEvents.length).toBeGreaterThanOrEqual(1);

    const event = inputRunEvents[inputRunEvents.length - 1];
    expect(event?.payload).toMatchObject({
      command: 'echo event-test',
      noWait: true,
    });
  });

  it('returns timedOut when marker is not found within timeout', async () => {
    // Disable terminal echo so the injected marker does not appear in visible output.
    sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'stty -echo; exec sleep 60',
    ]);
    await sleep(500);

    const result = runCli(
      ['run', sessionId, 'echo delayed', '--timeout', '2000', '--json'],
      testEnv(),
      30_000,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
      accepted: true;
      completed: boolean;
      timedOut: boolean;
      seq: number;
      durationMs: number;
      marker: string;
    }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.accepted).toBe(true);
    expect(envelope.result.timedOut).toBe(true);
    expect(envelope.result.completed).toBe(false);
    expect(envelope.result.durationMs).toBeGreaterThanOrEqual(1500);
    expect(envelope.result.marker).toMatch(/^__AT_MARKER_/);
  });

  it('completes when marker is found in rendered output', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(1000);

    const result = runCli(
      ['run', sessionId, 'echo hello', '--timeout', '15000', '--json'],
      testEnv(),
      30_000,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
      accepted: true;
      completed: boolean;
      timedOut: boolean;
      seq: number;
      durationMs: number;
      marker: string;
    }>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.accepted).toBe(true);
    expect(envelope.result.completed).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.durationMs).toBeTypeOf('number');
    expect(envelope.result.marker).toMatch(/^__AT_MARKER_/);
  });
});
