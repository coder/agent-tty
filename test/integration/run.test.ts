import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
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
  type EventRecord,
  type SuccessEnvelope,
} from '../helpers.js';
import { RUN_MARKER_PATTERN } from '../../src/host/runCompletionSentinel.js';
import type { CommandErrorEnvelope } from '../../src/protocol/envelope.js';

function expectRunMarker(marker: string): string {
  const match = RUN_MARKER_PATTERN.exec(marker);
  expect(match).not.toBeNull();

  const markerPayload = match?.[1];
  if (markerPayload === undefined) {
    throw new Error('expected run marker payload to be captured');
  }

  return markerPayload;
}

function collectOutputText(events: EventRecord[]): string {
  return events
    .filter((event) => event.type === 'output')
    .map((event) => {
      const data = event.payload.data;
      if (typeof data !== 'string') {
        throw new Error('output event payload data must be a string');
      }
      return data;
    })
    .join('');
}

function expectCompletionArtifactsClean(text: string, marker: string): void {
  const markerPayload = expectRunMarker(marker);
  const markerPayloadPart1 = markerPayload.slice(0, 16);
  const markerPayloadPart2 = markerPayload.slice(16);

  expect(text).not.toContain('__AT_MARKER_');
  expect(text).not.toContain('__AT_');
  expect(text).not.toContain('MARKER_');
  expect(text).not.toContain("printf '\\033");
  expect(text).not.toContain('agent-tty:run-complete:');
  expect(text).not.toContain(markerPayload);
  expect(text).not.toContain(markerPayloadPart1);
  expect(text).not.toContain(markerPayloadPart2);
  expect(text).not.toContain('\x1b_agent-tty');
  expect(text).not.toContain(`\x1b_agent-tty:run-complete:${marker}\x1b\\`);
}

function collectAsciicastOutputFrameText(contents: string): string {
  return contents
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => JSON.parse(line) as unknown)
    .filter(
      (frame): frame is [number, 'o', string] =>
        Array.isArray(frame) &&
        frame[1] === 'o' &&
        typeof frame[2] === 'string',
    )
    .map((frame) => frame[2])
    .join('');
}

let testHome = '';
let sessionId = '';

function testEnv(): Record<string, string> {
  return { AGENT_TTY_HOME: testHome };
}

describe('run command integration', { timeout: 45_000 }, () => {
  beforeEach(() => {
    // prettier-ignore
    testHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-run-home-')));
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

  it('handles multiline command input', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(1000);

    const result = runCli(
      ['run', sessionId, 'echo line1\necho line2', '--json'],
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
  });

  it('waits for the command to complete before reporting success', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(1000);

    const start = Date.now();
    const result = runCli(
      ['run', sessionId, 'sleep 2', '--timeout', '10000', '--json'],
      testEnv(),
      15_000,
    );
    const elapsed = Date.now() - start;

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
    expect(elapsed).toBeGreaterThan(1500);
    expect(envelope.result.durationMs).toBeGreaterThan(1500);
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

  it('returns timedOut when run completion is not observed within timeout', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(500);

    const result = runCli(
      ['run', sessionId, 'sleep 5', '--timeout', '300', '--json'],
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
    expect(envelope.result.durationMs).toBeGreaterThanOrEqual(250);
    const marker = envelope.result.marker;
    expectRunMarker(marker);

    const events = await readEvents(testHome, sessionId);
    expect(
      events.some(
        (event) =>
          event.type === 'run_complete' && event.payload.marker === marker,
      ),
    ).toBe(false);
  });

  it('preserves command output in line-discipline echo shells', async () => {
    sessionId = createSession(testHome, ['/bin/sh']);
    await sleep(1000);

    const result = runCli(
      [
        'run',
        sessionId,
        "printf 'dash-before-proof\\n'; sleep 0.1; printf 'dash-after-proof\\n'",
        '--timeout',
        '15000',
        '--json',
      ],
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
    const marker = envelope.result.marker;
    expectRunMarker(marker);

    const events = await readEvents(testHome, sessionId);
    const outputText = collectOutputText(events);
    expect(outputText).toContain('dash-before-proof');
    expect(outputText).toContain('dash-after-proof');
    expectCompletionArtifactsClean(outputText, marker);
  });

  it('keeps later output visible after a timed-out line-discipline echo run', async () => {
    sessionId = createSession(testHome, ['/bin/sh']);
    await sleep(1000);

    const result = runCli(
      ['run', sessionId, 'cat', '--timeout', '300', '--json'],
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
    expect(envelope.result.completed).toBe(false);
    expect(envelope.result.timedOut).toBe(true);
    const marker = envelope.result.marker;
    expectRunMarker(marker);

    const typeResult = runCli(
      [
        'type',
        sessionId,
        'timeout-still-visible',
        '--append-newline',
        '--json',
      ],
      testEnv(),
      30_000,
    );
    expect(typeResult.status).toBe(0);
    expect(typeResult.stderr).toBe('');
    await sleep(500);

    const events = await readEvents(testHome, sessionId);
    const outputText = collectOutputText(events);
    expect(outputText).toContain('timeout-still-visible');
    expectCompletionArtifactsClean(outputText, marker);
  });

  it('detects session exit during wait before timing out', async () => {
    sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      'stty -echo; exec sleep 2',
    ]);
    await sleep(500);

    const result = runCli(
      ['run', sessionId, 'echo never-runs', '--timeout', '10000', '--json'],
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
    expect(envelope.result.completed).toBe(false);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.durationMs).toBeLessThan(10_000);
  });

  it('does not log postamble cursor controls when shell echo is disabled', async () => {
    sessionId = createSession(testHome, ['/bin/bash', '--noprofile', '--norc']);
    await sleep(1000);

    const disableEchoResult = runCli(
      ['run', sessionId, 'stty -echo', '--timeout', '15000', '--json'],
      testEnv(),
      30_000,
    );
    expect(disableEchoResult.status).toBe(0);
    expect(disableEchoResult.stderr).toBe('');

    const result = runCli(
      [
        'run',
        sessionId,
        "printf 'noecho-before-proof\\n'; printf 'noecho-after-proof\\n'",
        '--timeout',
        '15000',
        '--json',
      ],
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
    const marker = envelope.result.marker;
    expectRunMarker(marker);

    const events = await readEvents(testHome, sessionId);
    const outputText = collectOutputText(events);
    expect(outputText).toContain('noecho-before-proof');
    expect(outputText).toContain('noecho-after-proof');
    expect(outputText).not.toContain('\x1b[1A');
    expect(outputText).not.toContain('\x1b[2K');
    expectCompletionArtifactsClean(outputText, marker);

    const snapshotResult = runCli(
      [
        'snapshot',
        sessionId,
        '--format',
        'text',
        '--include-scrollback',
        '--json',
      ],
      testEnv(),
      30_000,
    );
    expect(snapshotResult.status).toBe(0);
    expect(snapshotResult.stderr).toBe('');
    const snapshotEnvelope = JSON.parse(
      snapshotResult.stdout,
    ) as SuccessEnvelope<{
      text: string;
    }>;
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.result.text).toContain('noecho-before-proof');
    expect(snapshotEnvelope.result.text).toContain('noecho-after-proof');
    expect(snapshotEnvelope.result.text).not.toContain('\x1b[1A');
    expect(snapshotEnvelope.result.text).not.toContain('\x1b[2K');
    expectCompletionArtifactsClean(snapshotEnvelope.result.text, marker);
  });

  it('records structured run completion without leaking sentinel text to artifacts', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(1000);

    const result = runCli(
      [
        'run',
        sessionId,
        "printf 'before-clean-marker-proof\\n'; printf 'after-clean-marker-proof\\n'",
        '--timeout',
        '15000',
        '--json',
      ],
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
    const marker = envelope.result.marker;
    expectRunMarker(marker);

    const events = await readEvents(testHome, sessionId);
    const runCompleteEvents = events.filter(
      (event) =>
        event.type === 'run_complete' && event.payload.marker === marker,
    );
    expect(runCompleteEvents).toHaveLength(1);

    const [runCompleteEvent] = runCompleteEvents;
    if (runCompleteEvent === undefined) {
      throw new Error('expected run_complete event to exist');
    }
    const inputRunSeq = runCompleteEvent.payload.inputRunSeq;
    if (inputRunSeq !== undefined) {
      expect(inputRunSeq).toBeTypeOf('number');
      const inputRunEvent = events.find((event) => event.seq === inputRunSeq);
      expect(inputRunEvent?.type).toBe('input_run');
      expect(inputRunEvent?.payload).toMatchObject({ marker });
    }

    const outputText = collectOutputText(events);
    expect(outputText).toContain('before-clean-marker-proof');
    expect(outputText).toContain('after-clean-marker-proof');
    expectCompletionArtifactsClean(outputText, marker);

    const snapshotResult = runCli(
      [
        'snapshot',
        sessionId,
        '--format',
        'text',
        '--include-scrollback',
        '--json',
      ],
      testEnv(),
      30_000,
    );
    expect(snapshotResult.status).toBe(0);
    expect(snapshotResult.stderr).toBe('');
    const snapshotEnvelope = JSON.parse(
      snapshotResult.stdout,
    ) as SuccessEnvelope<{
      text: string;
    }>;
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.result.text).toContain('before-clean-marker-proof');
    expect(snapshotEnvelope.result.text).toContain('after-clean-marker-proof');
    expectCompletionArtifactsClean(snapshotEnvelope.result.text, marker);

    const asciicastPath = join(testHome, 'run-cleanliness.cast');
    const exportResult = runCli(
      [
        'record',
        'export',
        sessionId,
        '--format',
        'asciicast',
        '--out',
        asciicastPath,
        '--json',
      ],
      testEnv(),
      30_000,
    );
    expect(exportResult.status).toBe(0);
    expect(exportResult.stderr).toBe('');

    const asciicastOutputText = collectAsciicastOutputFrameText(
      readFileSync(asciicastPath, 'utf8'),
    );
    expect(asciicastOutputText).toContain('before-clean-marker-proof');
    expect(asciicastOutputText).toContain('after-clean-marker-proof');
    expectCompletionArtifactsClean(asciicastOutputText, marker);
  });
});
