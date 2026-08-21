import { readFile, stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  RecordDiffResult,
  ScreenshotResult,
  SnapshotResult,
  WaitForRenderResult,
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
  return { AGENT_TTY_HOME: home };
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
    const { scrollbackLines } = structuredSnapshotEnvelope.result;
    expect(scrollbackLines).toBeDefined();
    expect(scrollbackLines?.length).toBeGreaterThan(0);

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

  it('diffs the scrolled viewport against its pre-completion state', () => {
    const env = testEnv(testHome);
    // The stdin handshake keeps the fixture blocked before the completion
    // marker, so the wait below observes an ingested Event Log state that is
    // guaranteed to precede the marker — no PTY chunk-coalescing race.
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      [
        'create',
        '--rows',
        '10',
        '--cols',
        '80',
        '--',
        ...fixtureCommand('scrollback-demo'),
        '--wait-input-before-complete',
      ],
      env,
    );
    expect(createEnvelope.ok).toBe(true);
    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const waitEnvelope = runCliJson<SuccessEnvelope<WaitForRenderResult>>(
      ['wait', sessionId, '--text', 'LINE 080', '--timeout', '15000'],
      env,
    );
    expect(waitEnvelope.ok).toBe(true);
    expect(waitEnvelope.result.matched).toBe(true);
    const preCompletionSeq = waitEnvelope.result.capturedAtSeq;

    const releaseEnvelope = runCliJson<SuccessEnvelope<unknown>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(releaseEnvelope.ok).toBe(true);

    const exitEnvelope = runCliJson<SuccessEnvelope<WaitResult>>(
      ['wait', sessionId, '--exit', '--timeout', String(EXIT_WAIT_TIMEOUT_MS)],
      env,
    );
    expect(exitEnvelope.ok).toBe(true);
    expect(exitEnvelope.result.exitCode).toBe(0);

    // `record diff` against the observed pre-completion sequence proves the
    // viewport scrolled: the final screen (equal + add entries) gained the
    // completion marker and no longer shows the first line.
    const diffEnvelope = runCliJson<SuccessEnvelope<RecordDiffResult>>(
      [
        'record',
        'diff',
        sessionId,
        sessionId,
        '--at-seq-a',
        String(preCompletionSeq),
      ],
      env,
    );
    expect(diffEnvelope.ok).toBe(true);
    expect(diffEnvelope.command).toBe('record diff');
    expect(diffEnvelope.result.identical).toBe(false);
    const preCompletionLines = diffEnvelope.result.diff
      .filter((entry) => entry.op !== 'add')
      .map((entry) => entry.text);
    expect(
      preCompletionLines.some((line) => line.includes('SCROLLBACK COMPLETE')),
    ).toBe(false);
    const finalScreenLines = diffEnvelope.result.diff
      .filter((entry) => entry.op !== 'delete')
      .map((entry) => entry.text);
    expect(
      finalScreenLines.some((line) => line.includes('SCROLLBACK COMPLETE')),
    ).toBe(true);
    expect(finalScreenLines.some((line) => line.includes('LINE 001'))).toBe(
      false,
    );
  });
});
