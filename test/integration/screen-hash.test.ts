import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  SnapshotResult,
  WaitForRenderResult,
} from '../../src/protocol/messages.js';
import {
  cleanupHome,
  createSession,
  crashSession,
  destroySession,
  inspectSession,
  readEvents,
  runCli,
  sleep,
  type SuccessEnvelope,
  type WaitResult,
} from '../helpers.js';

// A session that emits a stable marker and then idles, so the rendered screen
// has settled visible content the wait and snapshot paths can hash.
const SESSION_COMMAND = [
  '/bin/sh',
  '-c',
  "printf 'booting\\n'; sleep 1; printf 'Ready\\n'; exec cat",
] as const;
const HOOK_TIMEOUT_MS = 30_000;

const SHA_256_HEX = /^[a-f0-9]{64}$/u;

type StructuredSnapshot = Extract<SnapshotResult, { format: 'structured' }>;
type TextSnapshot = Extract<SnapshotResult, { format: 'text' }>;

async function waitForOutputMarker(
  testHome: string,
  sessionId: string,
  marker: string,
): Promise<void> {
  const waitResult = runCli(
    ['wait', sessionId, '--idle-ms', '200', '--timeout', '10000', '--json'],
    { AGENT_TTY_HOME: testHome },
    15_000,
  );

  expect(waitResult.status).toBe(0);
  expect(waitResult.stderr).toBe('');
  const waitEnvelope = JSON.parse(
    waitResult.stdout,
  ) as SuccessEnvelope<WaitResult>;
  expect(waitEnvelope.ok).toBe(true);
  expect(waitEnvelope.result.timedOut).toBe(false);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const events = await readEvents(testHome, sessionId).catch(() => []);
    const output = events
      .filter((event) => event.type === 'output')
      .map((event) => {
        const data = event.payload.data;
        return typeof data === 'string' ? data : '';
      })
      .join('');

    if (output.includes(marker)) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`timed out waiting for output marker ${marker}`);
}

describe('screen hash integration', { timeout: 120_000 }, () => {
  let testHome = '';
  let sessionId = '';

  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-screen-hash-')));
    sessionId = createSession(testHome, [...SESSION_COMMAND]);
    await waitForOutputMarker(testHome, sessionId, 'booting');
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    destroySession(testHome, sessionId);
    await cleanupHome(testHome);
    sessionId = '';
    testHome = '';
  }, HOOK_TIMEOUT_MS);

  it('includes screenHash on a structured snapshot', () => {
    const result = runCli(
      ['snapshot', sessionId, '--format', 'structured', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<StructuredSnapshot>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.format).toBe('structured');
    expect(envelope.result.screenHash).toMatch(SHA_256_HEX);
  });

  it('includes screenHash on a text snapshot', () => {
    const result = runCli(
      ['snapshot', sessionId, '--format', 'text', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout) as SuccessEnvelope<TextSnapshot>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.format).toBe('text');
    expect(envelope.result.screenHash).toMatch(SHA_256_HEX);
  });

  it('agrees on screenHash between structured and text snapshots of the same screen', () => {
    // Settle the rendered screen: wait until `Ready` is visible AND the screen
    // has been stable, so the two independent snapshot captures below observe
    // the SAME screen. Without this, the structured capture can land before the
    // 1s `Ready` print and the text capture after it, yielding two correct-but-
    // different hashes (see SESSION_COMMAND).
    const settle = runCli(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--screen-stable-ms',
        '500',
        '--timeout',
        '15000',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );
    expect(settle.status).toBe(0);
    const settleEnvelope = JSON.parse(
      settle.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(settleEnvelope.ok).toBe(true);
    expect(settleEnvelope.result.matched).toBe(true);
    expect(settleEnvelope.result.timedOut).toBe(false);

    const structured = runCli(
      ['snapshot', sessionId, '--format', 'structured', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );
    const text = runCli(
      ['snapshot', sessionId, '--format', 'text', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(structured.status).toBe(0);
    expect(text.status).toBe(0);
    const structuredEnvelope = JSON.parse(
      structured.stdout,
    ) as SuccessEnvelope<StructuredSnapshot>;
    const textEnvelope = JSON.parse(
      text.stdout,
    ) as SuccessEnvelope<TextSnapshot>;

    expect(structuredEnvelope.result.screenHash).toMatch(SHA_256_HEX);
    expect(textEnvelope.result.screenHash).toBe(
      structuredEnvelope.result.screenHash,
    );
  });

  it('includes screenHash on a matched render wait', () => {
    const result = runCli(
      ['wait', sessionId, '--text', 'Ready', '--timeout', '15000', '--json'],
      { AGENT_TTY_HOME: testHome },
      20_000,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(true);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.screenHash).toMatch(SHA_256_HEX);
  });

  it('omits screenHash on a timed-out render wait', () => {
    const result = runCli(
      [
        'wait',
        sessionId,
        '--text',
        'TEXT_THAT_NEVER_APPEARS',
        '--timeout',
        '2000',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.status).toBe(11);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(false);
    expect(envelope.result.timedOut).toBe(true);
    expect(envelope.result.screenHash).toBeUndefined();
  });

  it('includes screenHash on the offline host-unreachable matched:false fallback', async () => {
    // Settle on the visible marker, then kill the host so the wait falls back
    // to offline replay. A screen-stability wait cannot prove the stable
    // duration from a single offline snapshot, so it returns matched:false —
    // but a Semantic Snapshot was still observed, so the hash is present.
    await waitForOutputMarker(testHome, sessionId, 'Ready');

    crashSession(testHome, sessionId);
    await sleep(500);
    expect(inspectSession(testHome, sessionId).status).toBe('failed');

    const result = runCli(
      [
        'wait',
        sessionId,
        '--screen-stable-ms',
        '1000',
        '--timeout',
        '5000',
        '--json',
      ],
      { AGENT_TTY_HOME: testHome },
      15_000,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<WaitForRenderResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.matched).toBe(false);
    expect(envelope.result.timedOut).toBe(false);
    expect(envelope.result.screenHash).toMatch(SHA_256_HEX);
  });
});
