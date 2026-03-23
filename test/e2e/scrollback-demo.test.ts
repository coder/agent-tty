import { readFile, stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ScreenshotResult,
  SnapshotResult,
} from '../../src/protocol/messages.js';
import {
  cleanupHome,
  createIsolatedHome,
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
const EXIT_WAIT_TIMEOUT_MS = 15_000;

function testEnv(home: string): Record<string, string> {
  return { AGENT_TERMINAL_HOME: home };
}

function expectStructuredSnapshot(
  result: SnapshotResult,
): asserts result is Extract<SnapshotResult, { format: 'structured' }> {
  expect(result.format).toBe('structured');

  if (result.format !== 'structured') {
    throw new Error('expected structured snapshot result');
  }
}

function expectTextSnapshot(
  result: SnapshotResult,
): asserts result is Extract<SnapshotResult, { format: 'text' }> {
  expect(result.format).toBe('text');

  if (result.format !== 'text') {
    throw new Error('expected text snapshot result');
  }
}

describe('scrollback-demo e2e', { timeout: 60_000 }, () => {
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

  it('captures the viewport separately from the full output history', async () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      [
        'create',
        '--rows',
        '10',
        '--cols',
        '80',
        '--',
        ...fixtureCommand('scrollback-demo'),
      ],
      env,
    );

    expect(createEnvelope.ok).toBe(true);
    expect(createEnvelope.command).toBe('create');

    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const waitForExitEnvelope = runCliJson<SuccessEnvelope<WaitResult>>(
      ['wait', sessionId, '--exit', '--timeout', String(EXIT_WAIT_TIMEOUT_MS)],
      env,
    );
    expect(waitForExitEnvelope.ok).toBe(true);
    expect(waitForExitEnvelope.command).toBe('wait');
    expect(waitForExitEnvelope.result.timedOut).toBe(false);
    expect(waitForExitEnvelope.result.exitCode).toBe(0);

    const rawOutput = normalizeTerminalOutput(
      await readOutput(testHome, sessionId),
    );
    expect(rawOutput).toContain('LINE 001');
    expect(rawOutput).toContain('LINE 040');
    expect(rawOutput).toContain('LINE 080');
    expect(rawOutput).toContain('SCROLLBACK COMPLETE');

    const textSnapshotEnvelope = runCliJson<SuccessEnvelope<SnapshotResult>>(
      ['snapshot', sessionId, '--format', 'text'],
      env,
    );
    expect(textSnapshotEnvelope.ok).toBe(true);
    expect(textSnapshotEnvelope.command).toBe('snapshot');
    expectTextSnapshot(textSnapshotEnvelope.result);
    expect(textSnapshotEnvelope.result.sessionId).toBe(sessionId);
    expect(textSnapshotEnvelope.result.text).toContain('SCROLLBACK COMPLETE');
    expect(textSnapshotEnvelope.result.text).not.toContain('LINE 001');

    const structuredSnapshotEnvelope = runCliJson<
      SuccessEnvelope<SnapshotResult>
    >(['snapshot', sessionId, '--include-scrollback'], env);
    expect(structuredSnapshotEnvelope.ok).toBe(true);
    expect(structuredSnapshotEnvelope.command).toBe('snapshot');
    expectStructuredSnapshot(structuredSnapshotEnvelope.result);
    expect(structuredSnapshotEnvelope.result.sessionId).toBe(sessionId);
    expect(structuredSnapshotEnvelope.result.scrollbackLines).toBeDefined();
    expect(
      structuredSnapshotEnvelope.result.scrollbackLines!.length,
    ).toBeGreaterThan(0);

    const visibleText = structuredSnapshotEnvelope.result.visibleLines
      .map((line) => line.text)
      .join('\n');

    expect(visibleText).toContain('SCROLLBACK COMPLETE');
    expect(visibleText).not.toContain('LINE 001');

    const screenshotEnvelope = runCliJson<SuccessEnvelope<ScreenshotResult>>(
      ['screenshot', sessionId],
      env,
    );
    expect(screenshotEnvelope.ok).toBe(true);
    expect(screenshotEnvelope.command).toBe('screenshot');
    expect(screenshotEnvelope.result.sessionId).toBe(sessionId);
    expect(screenshotEnvelope.result.artifactPath).toMatch(/\.png$/);
    expect(screenshotEnvelope.result.pngSizeBytes).toBeGreaterThan(0);

    const screenshotStats = await stat(screenshotEnvelope.result.artifactPath);
    expect(screenshotStats.size).toBe(screenshotEnvelope.result.pngSizeBytes);

    const screenshotBytes = await readFile(
      screenshotEnvelope.result.artifactPath,
    );
    expect(screenshotBytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC_HEX);
  });
});
