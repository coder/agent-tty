import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BatchResult } from '../../src/batch/result.js';

import {
  cleanupHome,
  createIsolatedHome,
  fixtureCommand,
  normalizeTerminalOutput,
  readOutput,
  runCli,
  runCliJson,
  type SuccessEnvelope,
} from './helpers.js';

interface CreateResult {
  sessionId: string;
}

function testEnv(home: string): Record<string, string> {
  return { AGENT_TTY_HOME: home };
}

// These flows drive a BUNDLED fixture (never nvim) through ONE batch
// invocation each. They require a real PTY + ghostty-web renderer, so they do
// NOT run in the sandbox (HOST_UNREACHABLE / no browser); they are gated by
// typecheck + static review and exercised in CI. Structure mirrors
// hello-prompt.test.ts.
describe('batch fixture e2e', { timeout: 30_000 }, () => {
  let testHome = '';
  let createdSessionIds: string[] = [];

  beforeEach(async () => {
    testHome = await createIsolatedHome();
    createdSessionIds = [];
  });

  afterEach(async () => {
    const env = testEnv(testHome);

    for (const sessionId of createdSessionIds) {
      runCli(['destroy', sessionId, '--force', '--json'], env);
    }

    await cleanupHome(testHome);
  });

  it('drives the alt-screen TUI fixture through one batch', async () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      ['create', '--', ...fixtureCommand('alt-screen-demo')],
      env,
    );
    expect(createEnvelope.ok).toBe(true);

    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    // One batch: settle on the main screen, advance into the alt screen, wait
    // for its label, advance back, wait for the restored main screen. Each
    // post-input wait is anchored to the Wait Baseline of the preceding
    // sendKeys, so it cannot match the screen left by an earlier step.
    const steps = JSON.stringify([
      { wait: { screenStableMs: 1000, timeout: 10_000 } },
      { sendKeys: ['Enter'] },
      { wait: { text: 'ALT SCREEN ACTIVE', timeout: 10_000 } },
      { sendKeys: ['Enter'] },
      { wait: { text: 'BACK ON MAIN SCREEN', timeout: 10_000 } },
    ]);

    const batchEnvelope = runCliJson<SuccessEnvelope<BatchResult>>(
      ['batch', sessionId, steps],
      env,
    );

    expect(batchEnvelope.ok).toBe(true);
    expect(batchEnvelope.command).toBe('batch');
    expect(batchEnvelope.result.failedIndices).toEqual([]);
    expect(batchEnvelope.result.completedCount).toBe(5);
    expect(batchEnvelope.result.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]);

    // The second wait (index 2) is anchored to the seq the first sendKeys
    // produced — the Wait Baseline the executor threaded through.
    const [, firstKeys, altWait] = batchEnvelope.result.steps;
    if (firstKeys?.kind === 'sendKeys' && altWait?.kind === 'wait') {
      expect(altWait.waitBaseline).toBe(firstKeys.seq);
    }

    const output = normalizeTerminalOutput(
      await readOutput(testHome, sessionId),
    );
    expect(output).toContain('ALT SCREEN ACTIVE');
    expect(output).toContain('BACK ON MAIN SCREEN');
  });

  it('drives the hello-prompt fixture through one batch (type, sendKeys, anchored wait)', async () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      ['create', '--', ...fixtureCommand('hello-prompt')],
      env,
    );
    expect(createEnvelope.ok).toBe(true);

    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    // One batch exercises type/sendKeys/wait against the prompt fixture. The
    // leading wait matches the prompt WITHOUT its trailing space: the raw
    // output keeps "READY> ", but the rendered snapshot trims trailing blank
    // cells, so the grid shows "READY>". The final wait uses a distinctive
    // token (not the literal typed text) so it anchors on the fixture's ECHO
    // line rather than the keystroke echo — the documented echo-match limit.
    const steps = JSON.stringify([
      { wait: { text: 'READY>', timeout: 10_000 } },
      { type: 'batchtoken9' },
      { sendKeys: ['Enter'] },
      { wait: { text: 'ECHO: batchtoken9', timeout: 10_000 } },
    ]);

    const batchEnvelope = runCliJson<SuccessEnvelope<BatchResult>>(
      ['batch', sessionId, steps],
      env,
    );

    expect(batchEnvelope.ok).toBe(true);
    expect(batchEnvelope.result.failedIndices).toEqual([]);
    expect(batchEnvelope.result.completedCount).toBe(4);
    expect(batchEnvelope.result.steps.map((step) => step.kind)).toEqual([
      'wait',
      'type',
      'sendKeys',
      'wait',
    ]);

    const output = normalizeTerminalOutput(
      await readOutput(testHome, sessionId),
    );
    expect(output).toContain('ECHO: batchtoken9');
  });
});
