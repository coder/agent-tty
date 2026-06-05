import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BatchResult } from '../../src/batch/result.js';
import type { CommandErrorEnvelope } from '../../src/protocol/envelope.js';

import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
  sleep,
  type SuccessEnvelope,
} from '../helpers.js';

let testHome = '';
let sessionId = '';

function testEnv(): Record<string, string> {
  return { AGENT_TTY_HOME: testHome };
}

describe('batch command integration', { timeout: 45_000 }, () => {
  beforeEach(() => {
    // oxfmt-ignore
    testHome = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tty-batch-home-')));
  });

  afterEach(async () => {
    destroySession(testHome, sessionId);
    sessionId = '';
    await cleanupHome(testHome);
    testHome = '';
  });

  // --- Parse-error cases run in-sandbox: parsing precedes target resolution,
  // so no live Session is required. ---

  it('rejects malformed JSON steps with INVALID_INPUT before resolving a target', () => {
    const result = runCli(
      ['batch', 'nonexistent-session', '{not json', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as CommandErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-array top-level steps payload with INVALID_INPUT', () => {
    const result = runCli(
      ['batch', 'nonexistent-session', '{"type":"hi"}', '--json'],
      testEnv(),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as CommandErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('JSON array');
  });

  it('rejects inline steps and --file together as mutually exclusive', () => {
    const stepsPath = join(testHome, 'steps.json');
    writeFileSync(stepsPath, JSON.stringify([{ type: 'hi' }]));

    const result = runCli(
      [
        'batch',
        'some-session',
        '[{"type":"hi"}]',
        '--file',
        stepsPath,
        '--json',
      ],
      testEnv(),
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as CommandErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
    expect(envelope.error.message).toContain('mutually exclusive');
  });

  it('rejects neither inline steps nor --file with INVALID_INPUT', () => {
    const result = runCli(['batch', 'some-session', '--json'], testEnv());

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as CommandErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  // --- Happy path requires a real PTY + renderer, so it does not run in this
  // sandbox (HOST_UNREACHABLE / no browser). It is gated by typecheck + static
  // review and exercised in CI where a live Session and renderer exist. ---

  it('runs an ordered multi-step plan against a live session', async () => {
    sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'booting\\n'; sleep 1; printf 'Ready\\n'; exec cat",
    ]);
    await sleep(500);

    const steps = JSON.stringify([
      { wait: { text: 'Ready', timeout: 10_000 } },
      { type: 'echo from-batch' },
      { sendKeys: ['Enter'] },
      { wait: { text: 'from-batch', timeout: 10_000 } },
    ]);

    const result = runCli(['batch', sessionId, steps, '--json'], testEnv());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<BatchResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.completedCount).toBe(4);
    expect(envelope.result.failedIndices).toEqual([]);
    expect(envelope.result.steps).toHaveLength(4);

    const [firstWait, typeStep, keysStep, secondWait] = envelope.result.steps;
    expect(firstWait).toMatchObject({ kind: 'wait', status: 'completed' });
    expect(typeStep).toMatchObject({ kind: 'type', status: 'completed' });
    expect(keysStep).toMatchObject({ kind: 'sendKeys', status: 'completed' });
    expect(secondWait).toMatchObject({ kind: 'wait', status: 'completed' });

    // The second wait is anchored to the seq the preceding sendKeys produced.
    if (keysStep?.kind === 'sendKeys' && secondWait?.kind === 'wait') {
      expect(secondWait.waitBaseline).toBe(keysStep.seq);
    }
  });

  it('reads the step array from --file', async () => {
    sessionId = createSession(testHome, ['/bin/bash']);
    await sleep(500);

    const stepsPath = join(testHome, 'plan.json');
    writeFileSync(
      stepsPath,
      JSON.stringify([{ run: 'echo file-driven', noWait: true }]),
    );

    const result = runCli(
      ['batch', sessionId, '--file', stepsPath, '--json'],
      testEnv(),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<BatchResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.completedCount).toBe(1);
    expect(envelope.result.steps[0]).toMatchObject({
      kind: 'run',
      status: 'completed',
      noWait: true,
    });
  });

  it('exits 11 when a wait times out under the default fail-fast policy', async () => {
    sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'Ready\\n'; exec cat",
    ]);
    await sleep(500);

    // The first wait can never match, so it times out; fail-fast stops the
    // batch and the trailing step is recorded not-run.
    const steps = JSON.stringify([
      { wait: { text: 'never-appears', timeout: 1000 } },
      { type: 'unreached' },
    ]);

    const result = runCli(['batch', sessionId, steps, '--json'], testEnv());

    // WAIT_TIMEOUT maps to exit code 11 — distinct from HOST_TIMEOUT (5) and
    // HOST_UNREACHABLE (6).
    expect(result.status).toBe(11);
    expect(result.stderr).toBe('');

    // The per-step envelope is still emitted (doctor pattern): a step failure
    // never routes through emitFailure, so steps[] is preserved.
    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<BatchResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.completedCount).toBe(0);
    expect(envelope.result.failedIndices).toEqual([0]);
    expect(envelope.result.steps).toHaveLength(2);

    const [waitStep, typeStep] = envelope.result.steps;
    expect(waitStep).toMatchObject({
      kind: 'wait',
      status: 'failed',
      timedOut: true,
      error: { code: 'WAIT_TIMEOUT' },
    });
    expect(typeStep).toMatchObject({ kind: 'type', status: 'not-run' });
  });

  it('exits non-zero with a full envelope under --keep-going on failure', async () => {
    sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'Ready\\n'; exec cat",
    ]);
    await sleep(500);

    // The first wait times out; --keep-going attempts every remaining step, so
    // the trailing input still runs and the run completes.
    const steps = JSON.stringify([
      { wait: { text: 'never-appears', timeout: 1000 } },
      { type: 'echo kept-going' },
      { sendKeys: ['Enter'] },
    ]);

    const result = runCli(
      ['batch', sessionId, steps, '--keep-going', '--json'],
      testEnv(),
    );

    // Keep-going collapses any failure to a fixed batch-level exit code of 1.
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');

    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<BatchResult>;
    expect(envelope.ok).toBe(true);
    // Every step was attempted: no not-run steps, multiple records present.
    expect(envelope.result.steps).toHaveLength(3);
    expect(
      envelope.result.steps.some((step) => step.status === 'not-run'),
    ).toBe(false);
    expect(envelope.result.failedIndices).toEqual([0]);
    expect(envelope.result.completedCount).toBe(2);
    expect(envelope.result.steps[0]).toMatchObject({
      kind: 'wait',
      status: 'failed',
      error: { code: 'WAIT_TIMEOUT' },
    });
  });
});
