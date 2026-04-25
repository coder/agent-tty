import { stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createIsolatedHome,
  DEFAULT_WAIT_TIMEOUT_MS,
  fixtureCommand,
  runCli,
  runCliJson,
  type SuccessEnvelope,
} from './helpers.js';
import type {
  ScreenshotResult,
  SnapshotResult,
  WaitForRenderResult,
} from '../../src/protocol/messages.js';

let nativeAvailable = false;
let nativeSkipReason = '';
try {
  await import('@coder/libghostty-vt-node');
  nativeAvailable = true;
} catch (error) {
  nativeSkipReason = error instanceof Error ? error.message : String(error);
}

interface CreateResult {
  sessionId: string;
}

interface SendKeysResult {
  accepted: string[];
  bytesWritten: number;
  seq: number;
}

function testEnv(home: string): Record<string, string> {
  return { AGENT_TTY_HOME: home };
}

const maybeIt = nativeAvailable ? it : it.skip;

describe('libghostty-vt renderer e2e', { timeout: 120_000 }, () => {
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

  maybeIt(
    nativeAvailable
      ? 'captures semantic state through libghostty-vt and screenshots through fallback'
      : `skips because @coder/libghostty-vt-node is unavailable: ${nativeSkipReason}`,
    async () => {
      const env = testEnv(testHome);
      const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
        ['create', '--', ...fixtureCommand('hello-prompt')],
        env,
      );
      expect(createEnvelope.ok).toBe(true);
      const sessionId = createEnvelope.result.sessionId;
      createdSessionIds.push(sessionId);

      const waitForReady = runCliJson<SuccessEnvelope<WaitForRenderResult>>(
        [
          '--renderer',
          'libghostty-vt',
          'wait',
          sessionId,
          '--text',
          'READY>',
          '--timeout',
          String(DEFAULT_WAIT_TIMEOUT_MS),
        ],
        env,
      );
      expect(waitForReady.result.timedOut).toBe(false);
      expect(waitForReady.result.matched).toBe(true);

      const typeEnvelope = runCliJson<SuccessEnvelope<Record<string, never>>>(
        ['type', sessionId, 'native hello'],
        env,
      );
      expect(typeEnvelope.ok).toBe(true);

      const enterEnvelope = runCliJson<SuccessEnvelope<SendKeysResult>>(
        ['send-keys', sessionId, 'Enter'],
        env,
      );
      expect(enterEnvelope.result.accepted).toEqual(['Enter']);

      const waitForEcho = runCliJson<SuccessEnvelope<WaitForRenderResult>>(
        [
          '--renderer',
          'libghostty-vt',
          'wait',
          sessionId,
          '--text',
          'ECHO: native hello',
          '--timeout',
          String(DEFAULT_WAIT_TIMEOUT_MS),
        ],
        env,
      );
      expect(waitForEcho.result.timedOut).toBe(false);
      expect(waitForEcho.result.matched).toBe(true);

      const snapshotEnvelope = runCliJson<SuccessEnvelope<SnapshotResult>>(
        [
          '--renderer',
          'libghostty-vt',
          'snapshot',
          sessionId,
          '--format',
          'structured',
        ],
        env,
      );
      expect(snapshotEnvelope.result.format).toBe('structured');
      if (snapshotEnvelope.result.format !== 'structured') {
        throw new Error('expected structured snapshot');
      }
      expect(
        snapshotEnvelope.result.visibleLines.some((line) =>
          line.text.includes('ECHO: native hello'),
        ),
      ).toBe(true);

      const screenshotEnvelope = runCliJson<SuccessEnvelope<ScreenshotResult>>(
        ['--renderer', 'libghostty-vt', 'screenshot', sessionId],
        env,
      );
      expect(screenshotEnvelope.result.rendererBackend).toBe('ghostty-web');
      const pngStats = await stat(screenshotEnvelope.result.artifactPath);
      expect(pngStats.size).toBeGreaterThan(0);
    },
  );
});
