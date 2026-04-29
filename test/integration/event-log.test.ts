import { mkdtemp, realpath } from 'node:fs/promises';
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
  type WaitResult,
} from '../helpers.js';

function runMixedActionSequence(testHome: string, sessionId: string): void {
  const env = { AGENT_TTY_HOME: testHome };

  const typeResult = runCli(['type', sessionId, 'hello', '--json'], env);
  expect(typeResult.status).toBe(0);
  expect(typeResult.stderr).toBe('');

  const sendKeysResult = runCli(
    ['send-keys', sessionId, 'Enter', '--json'],
    env,
  );
  expect(sendKeysResult.status).toBe(0);
  expect(sendKeysResult.stderr).toBe('');

  const pasteResult = runCli(['paste', sessionId, 'paste-text', '--json'], env);
  expect(pasteResult.status).toBe(0);
  expect(pasteResult.stderr).toBe('');

  const resizeResult = runCli(
    ['resize', sessionId, '--cols', '100', '--rows', '30', '--json'],
    env,
  );
  expect(resizeResult.status).toBe(0);
  expect(resizeResult.stderr).toBe('');

  const waitResult = runCli(
    ['wait', sessionId, '--idle-ms', '500', '--timeout', '5000', '--json'],
    env,
    30000,
  );
  expect(waitResult.status).toBe(0);
  expect(waitResult.stderr).toBe('');
  const envelope = JSON.parse(waitResult.stdout) as SuccessEnvelope<WaitResult>;
  expect(envelope.ok).toBe(true);
  expect(envelope.result.timedOut).toBe(false);
}

let testHome = '';

describe('event-log integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('mixed action sequence has monotonic seq', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      runMixedActionSequence(testHome, sessionId);
      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      expect(events.length).toBeGreaterThan(0);
      expect(events.map((event) => event.seq)).toEqual(
        events.map((_, index) => index),
      );

      const eventTypes = new Set(events.map((event) => event.type));
      expect([...eventTypes]).toEqual(
        expect.arrayContaining([
          'input_text',
          'input_keys',
          'input_paste',
          'resize',
          'output',
        ]),
      );
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it('all event records validate against expected structure', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome);
      await sleep(500);

      runMixedActionSequence(testHome, sessionId);
      await sleep(300);

      const events = await readEvents(testHome, sessionId);
      expect(events.length).toBeGreaterThan(0);

      for (const event of events) {
        expect(typeof event.seq).toBe('number');
        expect(Number.isInteger(event.seq)).toBe(true);
        expect(event.seq).toBeGreaterThanOrEqual(0);
        expect(typeof event.ts).toBe('string');
        expect(new Date(event.ts).toISOString()).toBe(event.ts);
        expect(typeof event.type).toBe('string');
        expect(event.type.length).toBeGreaterThan(0);
        expect(typeof event.payload).toBe('object');
        expect(event.payload).not.toBeNull();
        expect(Array.isArray(event.payload)).toBe(false);
      }
    } finally {
      destroySession(testHome, sessionId);
    }
  });
});
