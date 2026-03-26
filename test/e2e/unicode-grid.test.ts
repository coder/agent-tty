import { readFile, stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ScreenshotResult,
  SnapshotResult,
  WaitForRenderResult,
} from '../../src/protocol/messages.js';
import {
  cleanupHome,
  createIsolatedHome,
  DEFAULT_WAIT_TIMEOUT_MS,
  fixtureCommand,
  normalizeTerminalOutput,
  readOutput,
  runCli,
  runCliJson,
  type SuccessEnvelope,
  type WaitResult,
} from './helpers.js';

interface CreateResult {
  sessionId: string;
}

const PNG_MAGIC_HEX = '89504e470d0a1a0a';

function testEnv(home: string): Record<string, string> {
  return { AGENT_TERMINAL_HOME: home };
}

function expectTextSnapshot(
  result: SnapshotResult,
): asserts result is Extract<SnapshotResult, { format: 'text' }> {
  expect(result.format).toBe('text');

  if (result.format !== 'text') {
    throw new Error('expected text snapshot result');
  }
}

describe('unicode-grid e2e', { timeout: 60_000 }, () => {
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

  it('renders all Unicode categories and produces a valid screenshot', async () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      ['create', '--', ...fixtureCommand('unicode-grid')],
      env,
    );

    expect(createEnvelope.ok).toBe(true);
    expect(createEnvelope.command).toBe('create');

    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const waitForRenderEnvelope = runCliJson<
      SuccessEnvelope<WaitForRenderResult>
    >(
      [
        'wait',
        sessionId,
        '--text',
        'UNICODE GRID COMPLETE',
        '--timeout',
        String(10_000),
      ],
      env,
    );
    expect(waitForRenderEnvelope.ok).toBe(true);
    expect(waitForRenderEnvelope.command).toBe('wait');
    expect(waitForRenderEnvelope.result.matched).toBe(true);
    expect(waitForRenderEnvelope.result.timedOut).toBe(false);
    expect(waitForRenderEnvelope.result.matchedText).toBe(
      'UNICODE GRID COMPLETE',
    );

    const output = normalizeTerminalOutput(
      await readOutput(testHome, sessionId),
    );
    for (const label of ['ASCII', 'BOX', 'CJK', 'EMOJI', 'AMBIG', 'NERD']) {
      expect(output).toContain(label);
    }
    expect(output).toContain('UNICODE GRID COMPLETE');

    const snapshotEnvelope = runCliJson<SuccessEnvelope<SnapshotResult>>(
      ['snapshot', sessionId, '--format', 'text'],
      env,
    );
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.command).toBe('snapshot');
    expectTextSnapshot(snapshotEnvelope.result);
    expect(snapshotEnvelope.result.sessionId).toBe(sessionId);
    for (const label of ['ASCII', 'BOX', 'CJK', 'EMOJI', 'AMBIG', 'NERD']) {
      expect(snapshotEnvelope.result.text).toContain(label);
    }
    expect(snapshotEnvelope.result.text).toContain('');
    expect(snapshotEnvelope.result.text).toContain('');
    expect(snapshotEnvelope.result.text).toContain('UNICODE GRID COMPLETE');

    const screenshotEnvelope = runCliJson<SuccessEnvelope<ScreenshotResult>>(
      ['screenshot', sessionId],
      env,
    );
    expect(screenshotEnvelope.ok).toBe(true);
    expect(screenshotEnvelope.command).toBe('screenshot');
    expect(screenshotEnvelope.result.sessionId).toBe(sessionId);
    expect(screenshotEnvelope.result.artifactPath).toMatch(/\.png$/);
    expect(screenshotEnvelope.result.pngSizeBytes).toBeGreaterThan(1024);

    const screenshotStats = await stat(screenshotEnvelope.result.artifactPath);
    expect(screenshotStats.size).toBe(screenshotEnvelope.result.pngSizeBytes);

    const screenshotBytes = await readFile(
      screenshotEnvelope.result.artifactPath,
    );
    expect(screenshotBytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC_HEX);

    const waitForExitEnvelope = runCliJson<SuccessEnvelope<WaitResult>>(
      [
        'wait',
        sessionId,
        '--exit',
        '--timeout',
        String(DEFAULT_WAIT_TIMEOUT_MS),
      ],
      env,
    );
    expect(waitForExitEnvelope.ok).toBe(true);
    expect(waitForExitEnvelope.command).toBe('wait');
    expect(waitForExitEnvelope.result.timedOut).toBe(false);
    expect(waitForExitEnvelope.result.exitCode).toBe(0);
  });
});
