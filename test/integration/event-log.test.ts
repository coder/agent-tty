import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

  it('shows in inspect and in a timed-out wait that the stored log stopped', async () => {
    const preload = pathToFileURL(
      resolve('test/fixtures/plant-stopped-event-log.ts'),
    );
    const env = { AGENT_TTY_HOME: testHome };
    // The program prints a second line after the host started on the stopped
    // log, so the host never records it.
    const sessionId = createSession(
      testHome,
      ['/bin/sh', '-c', "sleep 1; printf 'after the stop\\n'; exec cat"],
      {
        env: {
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS ?? '',
            `--import=${preload.href}`,
          ].join(' '),
        },
      },
    );

    try {
      await sleep(1500);

      const inspectResult = runCli(['inspect', sessionId, '--json'], env);
      expect(inspectResult.status).toBe(0);
      const inspected = JSON.parse(inspectResult.stdout) as {
        result: { eventCount: number; eventLogStop?: unknown };
      };
      expect(inspected.result.eventCount).toBe(2);
      expect(inspected.result.eventLogStop).toEqual({
        reason: 'events',
        seq: 1,
      });

      const humanResult = runCli(['inspect', sessionId], env);
      expect(humanResult.status).toBe(0);
      expect(humanResult.stdout).toContain(
        'Event Log Stopped: at seq 1 (event limit); later events are not recorded',
      );

      // A wait that the stored log satisfies is not touched.
      const matched = runCli(
        ['wait', sessionId, '--text', 'planted output', '--json'],
        env,
        30_000,
      );
      expect(matched.status).toBe(0);
      expect(JSON.parse(matched.stdout)).toMatchObject({
        ok: true,
        result: { matched: true, timedOut: false },
      });

      const timedOut = runCli(
        [
          'wait',
          sessionId,
          '--text',
          'after the stop',
          '--timeout',
          '2000',
          '--json',
        ],
        env,
        30_000,
      );
      expect(timedOut.status).toBe(11);
      const envelope = JSON.parse(timedOut.stdout) as {
        error: {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        };
        result: { timedOut: boolean };
      };
      expect(envelope.error.code).toBe('WAIT_TIMEOUT');
      expect(envelope.error.message).toBe(
        'Wait timed out before its condition was met. The event log stopped at seq 1 (event limit), so output after it is not seen.',
      );
      expect(envelope.error.details?.eventLogStop).toEqual({
        reason: 'events',
        seq: 1,
      });
      expect(envelope.result.timedOut).toBe(true);

      const batchResult = runCli(
        [
          'batch',
          sessionId,
          JSON.stringify([{ wait: { text: 'after the stop', timeout: 2000 } }]),
          '--json',
        ],
        env,
        30_000,
      );
      expect(batchResult.status).toBe(11);
      const batchEnvelope = JSON.parse(batchResult.stdout) as {
        error: { code: string; message: string };
      };
      expect(batchEnvelope.error).toMatchObject({
        code: 'WAIT_TIMEOUT',
        message:
          'Render wait at step 0 timed out after 2000 ms. The event log stopped at seq 1 (event limit), so output after it is not seen.',
      });
    } finally {
      destroySession(testHome, sessionId);
    }
  }, 120_000);
});
