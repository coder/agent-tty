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

  describe('a log that stopped', () => {
    const NOTE =
      'The event log stopped at seq 1 (event limit), so output after it is not seen.';
    const env = (): Record<string, string> => ({ AGENT_TTY_HOME: testHome });

    // The host starts on a log that holds one output record and the stop
    // record, so it records nothing that the program prints after that.
    function createStoppedSession(
      script: string,
      plantedLabel?: string,
    ): string {
      const preload = pathToFileURL(
        resolve('test/fixtures/plant-stopped-event-log.ts'),
      );
      return createSession(testHome, ['/bin/sh', '-c', script], {
        env: {
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS ?? '',
            `--import=${preload.href}`,
          ].join(' '),
          ...(plantedLabel === undefined
            ? {}
            : { PLANT_STOP_LABEL: plantedLabel }),
        },
      });
    }

    it('shows the stop in inspect, in a timed-out wait and in batch waits of a live session', async () => {
      const sessionId = createStoppedSession(
        "sleep 1; printf 'after the stop\\n'; exec cat",
      );

      try {
        await sleep(1500);

        const inspectResult = runCli(['inspect', sessionId, '--json'], env());
        expect(inspectResult.status).toBe(0);
        expect(
          (JSON.parse(inspectResult.stdout) as { result: object }).result,
        ).toMatchObject({
          eventCount: 2,
          lastEventSeq: 1,
          eventLogStop: { reason: 'events', seq: 1 },
        });

        const humanResult = runCli(['inspect', sessionId], env());
        expect(humanResult.status).toBe(0);
        expect(humanResult.stdout).toContain(
          'Event Log Stopped: at seq 1 (event limit); later events are not recorded',
        );

        // A wait that the stored log satisfies is not touched.
        const matched = runCli(
          ['wait', sessionId, '--text', 'planted output', '--json'],
          env(),
          30_000,
        );
        expect(matched.status).toBe(0);
        expect(JSON.parse(matched.stdout) as object).toMatchObject({
          ok: true,
          result: { matched: true, timedOut: false },
        });

        // The host reports the stop with its timeout result.
        const timedOut = runCli(
          ['wait', sessionId, '--text', 'after the stop', '--timeout', '2000'],
          env(),
          30_000,
        );
        expect(timedOut.status).toBe(11);
        expect(timedOut.stderr).toContain(NOTE);

        const timedOutJson = runCli(
          [
            'wait',
            sessionId,
            '--text',
            'after the stop',
            '--timeout',
            '2000',
            '--json',
          ],
          env(),
          30_000,
        );
        expect(timedOutJson.status).toBe(11);
        const envelope = JSON.parse(timedOutJson.stdout) as {
          error: {
            code: string;
            message: string;
            details?: Record<string, unknown>;
          };
          result: { timedOut: boolean; eventLogStop?: unknown };
        };
        expect(envelope.error.code).toBe('WAIT_TIMEOUT');
        expect(envelope.error.message).toBe(
          `Wait timed out before its condition was met. ${NOTE}`,
        );
        expect(envelope.error.details?.eventLogStop).toEqual({
          reason: 'events',
          seq: 1,
        });
        expect(envelope.result).toMatchObject({
          timedOut: true,
          eventLogStop: { reason: 'events', seq: 1 },
        });

        const batchResult = runCli(
          [
            'batch',
            sessionId,
            JSON.stringify([
              { wait: { text: 'after the stop', timeout: 2000 } },
            ]),
            '--json',
          ],
          env(),
          30_000,
        );
        expect(batchResult.status).toBe(11);
        expect(
          (JSON.parse(batchResult.stdout) as { error: unknown }).error,
        ).toMatchObject({
          code: 'WAIT_TIMEOUT',
          message: `Render wait at step 0 timed out after 2000 ms. ${NOTE}`,
        });

        // Two failed waits, and no step reads the log again: each carries
        // the sentence.
        const keepGoing = runCli(
          [
            'batch',
            sessionId,
            JSON.stringify([
              { wait: { text: 'after the stop', timeout: 1500 } },
              { wait: { text: 'also after the stop', timeout: 1500 } },
            ]),
            '--keep-going',
            '--json',
          ],
          env(),
          60_000,
        );
        expect(keepGoing.status).toBe(1);
        const keepGoingResult = (
          JSON.parse(keepGoing.stdout) as {
            result: { failedIndices: number[]; steps: { error?: object }[] };
          }
        ).result;
        expect(keepGoingResult.failedIndices).toEqual([0, 1]);
        expect(keepGoingResult.steps.map((step) => step.error)).toEqual([
          expect.objectContaining({
            code: 'WAIT_TIMEOUT',
            message: `Render wait at step 0 timed out after 1500 ms. ${NOTE}`,
          }),
          expect.objectContaining({
            code: 'WAIT_TIMEOUT',
            message: `Render wait at step 1 timed out after 1500 ms. ${NOTE}`,
          }),
        ]);
      } finally {
        destroySession(testHome, sessionId);
      }
    }, 120_000);

    it('shows the stop for an exited session, also in a wait that has no host to ask', async () => {
      const sessionId = createStoppedSession(
        "sleep 1; printf 'after the stop\\n'",
      );

      try {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const status = (
            JSON.parse(
              runCli(['inspect', sessionId, '--json'], env()).stdout,
            ) as { result: { session: { status: string } } }
          ).result.session.status;
          if (status === 'exited') {
            break;
          }
          await sleep(250);
        }

        const inspectResult = runCli(['inspect', sessionId, '--json'], env());
        expect(inspectResult.status).toBe(0);
        expect(
          (JSON.parse(inspectResult.stdout) as { result: object }).result,
        ).toMatchObject({
          session: { status: 'exited' },
          eventLogStop: { reason: 'events', seq: 1 },
        });

        const matched = runCli(
          ['wait', sessionId, '--text', 'planted output', '--json'],
          env(),
          30_000,
        );
        expect(matched.status).toBe(0);

        const later = runCli(
          ['wait', sessionId, '--text', 'after the stop', '--json'],
          env(),
          30_000,
        );
        expect(later.status).toBe(10);
        const { error } = JSON.parse(later.stdout) as {
          error: {
            code: string;
            message: string;
            details?: Record<string, unknown>;
          };
        };
        expect(error.code).toBe('REPLAY_ERROR');
        expect(error.message).toBe(
          `Session host became unreachable during render wait, and the latest offline snapshot did not satisfy the requested wait condition. ${NOTE}`,
        );
        expect(error.details?.eventLogStop).toEqual({
          reason: 'events',
          seq: 1,
        });
      } finally {
        destroySession(testHome, sessionId);
      }
    }, 120_000);

    it('shows a stop marker that names no limit with the reason unknown instead of failing', async () => {
      const sessionId = createStoppedSession(
        "sleep 1; printf 'after the stop\\n'; exec cat",
        'agent-tty: event log limit reached (soon)',
      );

      try {
        await sleep(1500);

        const inspectResult = runCli(['inspect', sessionId, '--json'], env());
        expect(inspectResult.status).toBe(0);
        expect(
          (JSON.parse(inspectResult.stdout) as { result: object }).result,
        ).toMatchObject({ eventLogStop: { reason: 'unknown', seq: 1 } });

        const humanResult = runCli(['inspect', sessionId], env());
        expect(humanResult.status).toBe(0);
        expect(humanResult.stdout).toContain(
          'Event Log Stopped: at seq 1 (reason unknown); later events are not recorded',
        );

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
          env(),
          30_000,
        );
        expect(timedOut.status).toBe(11);
        expect(
          (JSON.parse(timedOut.stdout) as { error: unknown }).error,
        ).toMatchObject({
          code: 'WAIT_TIMEOUT',
          message:
            'Wait timed out before its condition was met. The event log stopped at seq 1 (reason unknown), so output after it is not seen.',
        });
      } finally {
        destroySession(testHome, sessionId);
      }
    }, 120_000);
  });
});
