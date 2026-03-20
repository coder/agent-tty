import { readFile, stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DoctorResult } from '../../src/cli/commands/doctor.js';
import type {
  ScreenshotResult,
  SnapshotResult,
  WaitForRenderResult,
} from '../../src/protocol/messages.js';
import { readArtifactManifest } from '../../src/storage/artifactManifest.js';
import { sessionDir } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createIsolatedHome,
  normalizeTerminalOutput,
  readOutput,
  runCli,
  type SuccessEnvelope,
  type WaitResult,
} from './helpers.js';

interface CreateResult {
  sessionId: string;
}

const DEFAULT_CLI_TIMEOUT_MS = 60_000;
const INITIAL_IDLE_MS = 200;
const INITIAL_WAIT_TIMEOUT_MS = 5_000;
const RENDER_WAIT_TIMEOUT_MS = 15_000;
const SCREEN_STABLE_MS = 1_000;
const PNG_MAGIC_HEX = '89504e470d0a1a0a';

function testEnv(home: string): Record<string, string> {
  return { AGENT_TERMINAL_HOME: home };
}

function withJsonFlag(args: string[]): string[] {
  const commandSeparatorIndex = args.indexOf('--');

  if (commandSeparatorIndex === -1) {
    return [...args, '--json'];
  }

  return [
    ...args.slice(0, commandSeparatorIndex),
    '--json',
    ...args.slice(commandSeparatorIndex),
  ];
}

function runCliEnvelope<TResult>(
  args: string[],
  env: Record<string, string>,
  timeout = DEFAULT_CLI_TIMEOUT_MS,
): SuccessEnvelope<TResult> {
  const result = runCli(withJsonFlag(args), env, timeout);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.length).toBeGreaterThan(0);

  return JSON.parse(result.stdout) as SuccessEnvelope<TResult>;
}

function stateTransitionCommand(): string[] {
  return [
    'node',
    '--import',
    'tsx',
    'test/fixtures/apps/state-transition/main.ts',
  ];
}

async function createRendererSession(
  home: string,
  createdSessionIds: string[],
): Promise<string> {
  const env = testEnv(home);
  const createEnvelope = runCliEnvelope<CreateResult>(
    ['create', '--', ...stateTransitionCommand()],
    env,
  );
  expect(createEnvelope.ok).toBe(true);
  expect(createEnvelope.command).toBe('create');

  const sessionId = createEnvelope.result.sessionId;
  createdSessionIds.push(sessionId);

  const waitEnvelope = runCliEnvelope<WaitResult>(
    [
      'wait',
      sessionId,
      '--idle-ms',
      String(INITIAL_IDLE_MS),
      '--timeout',
      String(INITIAL_WAIT_TIMEOUT_MS),
    ],
    env,
  );
  expect(waitEnvelope.ok).toBe(true);
  expect(waitEnvelope.command).toBe('wait');
  expect(waitEnvelope.result.timedOut).toBe(false);

  await expect(
    readOutput(home, sessionId).then((output) =>
      normalizeTerminalOutput(output),
    ),
  ).resolves.toContain('Loading...\n');

  return sessionId;
}

function expectStructuredSnapshot(
  result: SnapshotResult,
): asserts result is Extract<SnapshotResult, { format: 'structured' }> {
  expect(result.format).toBe('structured');
  expect(result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  expect(result.cols).toBeGreaterThan(0);
  expect(result.rows).toBeGreaterThan(0);

  if (result.format !== 'structured') {
    throw new Error('expected structured snapshot result');
  }
}

function expectTextSnapshot(
  result: SnapshotResult,
): asserts result is Extract<SnapshotResult, { format: 'text' }> {
  expect(result.format).toBe('text');
  expect(result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  expect(result.cols).toBeGreaterThan(0);
  expect(result.rows).toBeGreaterThan(0);

  if (result.format !== 'text') {
    throw new Error('expected text snapshot result');
  }
}

describe('renderer slice e2e', { timeout: 120_000 }, () => {
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

  it('captures a structured snapshot of visible terminal content', async () => {
    const env = testEnv(testHome);
    const sessionId = await createRendererSession(testHome, createdSessionIds);

    const waitEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );
    expect(waitEnvelope.ok).toBe(true);
    expect(waitEnvelope.result.matched).toBe(true);
    expect(waitEnvelope.result.timedOut).toBe(false);
    expect(waitEnvelope.result.matchedText).toBe('Ready');

    const snapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId],
      env,
    );
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.command).toBe('snapshot');
    expectStructuredSnapshot(snapshotEnvelope.result);
    expect(snapshotEnvelope.result.sessionId).toBe(sessionId);
    expect(
      snapshotEnvelope.result.visibleLines.some((line) =>
        line.text.includes('3 items'),
      ),
    ).toBe(true);
    expect(
      snapshotEnvelope.result.visibleLines.some((line) =>
        line.text.includes('Ready'),
      ),
    ).toBe(true);
  });

  it('returns text snapshots with --format text', async () => {
    const env = testEnv(testHome);
    const sessionId = await createRendererSession(testHome, createdSessionIds);

    const waitEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );
    expect(waitEnvelope.result.matched).toBe(true);
    expect(waitEnvelope.result.timedOut).toBe(false);

    const snapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId, '--format', 'text'],
      env,
    );
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.command).toBe('snapshot');
    expectTextSnapshot(snapshotEnvelope.result);
    expect(snapshotEnvelope.result.sessionId).toBe(sessionId);
    expect(snapshotEnvelope.result.text).toContain('3 items');
    expect(snapshotEnvelope.result.text).toContain('Ready');
  });

  it('captures a screenshot PNG and records snapshot/screenshot artifacts', async () => {
    const env = testEnv(testHome);
    const sessionId = await createRendererSession(testHome, createdSessionIds);

    const readyEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );
    expect(readyEnvelope.result.matched).toBe(true);
    expect(readyEnvelope.result.timedOut).toBe(false);

    const snapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId],
      env,
    );
    expect(snapshotEnvelope.ok).toBe(true);
    expectStructuredSnapshot(snapshotEnvelope.result);

    const screenshotEnvelope = runCliEnvelope<ScreenshotResult>(
      ['screenshot', sessionId],
      env,
      DEFAULT_CLI_TIMEOUT_MS,
    );
    expect(screenshotEnvelope.ok).toBe(true);
    expect(screenshotEnvelope.command).toBe('screenshot');
    expect(screenshotEnvelope.result.sessionId).toBe(sessionId);
    expect(screenshotEnvelope.result.profileName).toBe('reference-dark');
    expect(screenshotEnvelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
    expect(screenshotEnvelope.result.cols).toBeGreaterThan(0);
    expect(screenshotEnvelope.result.rows).toBeGreaterThan(0);
    expect(screenshotEnvelope.result.artifactPath).toMatch(/\.png$/);
    expect(screenshotEnvelope.result.pngSizeBytes).toBeGreaterThan(0);

    const screenshotStats = await stat(screenshotEnvelope.result.artifactPath);
    expect(screenshotStats.size).toBe(screenshotEnvelope.result.pngSizeBytes);

    const screenshotFile = await readFile(
      screenshotEnvelope.result.artifactPath,
    );
    expect(screenshotFile.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC_HEX);

    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual([
      'snapshot',
      'screenshot',
    ]);
    expect(manifest.artifacts[0]).toMatchObject({
      kind: 'snapshot',
      sessionId,
      capturedAtSeq: snapshotEnvelope.result.capturedAtSeq,
      metadata: {
        format: 'structured',
      },
    });
    expect(manifest.artifacts[1]).toMatchObject({
      kind: 'screenshot',
      sessionId,
      capturedAtSeq: screenshotEnvelope.result.capturedAtSeq,
      metadata: {
        profileName: 'reference-dark',
        pngSizeBytes: screenshotEnvelope.result.pngSizeBytes,
      },
    });
  });

  it('uses the requested screenshot profile', async () => {
    const env = testEnv(testHome);
    const sessionId = await createRendererSession(testHome, createdSessionIds);

    const readyEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );
    expect(readyEnvelope.result.matched).toBe(true);
    expect(readyEnvelope.result.timedOut).toBe(false);

    const screenshotEnvelope = runCliEnvelope<ScreenshotResult>(
      ['screenshot', sessionId, '--profile', 'reference-light'],
      env,
      DEFAULT_CLI_TIMEOUT_MS,
    );
    expect(screenshotEnvelope.ok).toBe(true);
    expect(screenshotEnvelope.command).toBe('screenshot');
    expect(screenshotEnvelope.result.sessionId).toBe(sessionId);
    expect(screenshotEnvelope.result.profileName).toBe('reference-light');
    expect(screenshotEnvelope.result.pngSizeBytes).toBeGreaterThan(0);

    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      kind: 'screenshot',
      sessionId,
      capturedAtSeq: screenshotEnvelope.result.capturedAtSeq,
      metadata: {
        profileName: 'reference-light',
        pngSizeBytes: screenshotEnvelope.result.pngSizeBytes,
      },
    });
  });

  it('waits for text matches', async () => {
    const env = testEnv(testHome);
    const sessionId = await createRendererSession(testHome, createdSessionIds);

    const waitEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );

    expect(waitEnvelope.ok).toBe(true);
    expect(waitEnvelope.command).toBe('wait');
    expect(waitEnvelope.result.matched).toBe(true);
    expect(waitEnvelope.result.timedOut).toBe(false);
    expect(waitEnvelope.result.matchedText).toBe('Ready');
    expect(waitEnvelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('waits for regex matches', async () => {
    const env = testEnv(testHome);
    const sessionId = await createRendererSession(testHome, createdSessionIds);

    const waitEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--regex',
        '\\d+ items',
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );

    expect(waitEnvelope.ok).toBe(true);
    expect(waitEnvelope.command).toBe('wait');
    expect(waitEnvelope.result.matched).toBe(true);
    expect(waitEnvelope.result.timedOut).toBe(false);
    expect(waitEnvelope.result.matchedText).toBe('3 items');
    expect(waitEnvelope.result.capturedAtSeq).toBeGreaterThanOrEqual(0);
  });

  it('waits for the screen to stop changing', async () => {
    const env = testEnv(testHome);
    const sessionId = await createRendererSession(testHome, createdSessionIds);

    const readyEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--text',
        'Ready',
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );
    expect(readyEnvelope.result.matched).toBe(true);
    expect(readyEnvelope.result.timedOut).toBe(false);

    const stableEnvelope = runCliEnvelope<WaitForRenderResult>(
      [
        'wait',
        sessionId,
        '--screen-stable-ms',
        String(SCREEN_STABLE_MS),
        '--timeout',
        String(RENDER_WAIT_TIMEOUT_MS),
      ],
      env,
      20_000,
    );

    expect(stableEnvelope.ok).toBe(true);
    expect(stableEnvelope.command).toBe('wait');
    expect(stableEnvelope.result.matched).toBe(true);
    expect(stableEnvelope.result.timedOut).toBe(false);
    expect(stableEnvelope.result.matchedText).toBeUndefined();
    expect(stableEnvelope.result.capturedAtSeq).toBeGreaterThanOrEqual(
      readyEnvelope.result.capturedAtSeq,
    );
  });

  it('reports renderer checks in doctor --json output', () => {
    const doctorEnvelope = runCliEnvelope<DoctorResult>(['doctor'], {}, 90_000);

    expect(doctorEnvelope.ok).toBe(true);
    expect(doctorEnvelope.command).toBe('doctor');
    expect(doctorEnvelope.result.ok).toBe(true);
    expect(doctorEnvelope.result.checks.environment.length).toBeGreaterThan(0);
    expect(doctorEnvelope.result.checks.renderer).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'playwright_available',
          status: 'pass',
        }),
        expect.objectContaining({ name: 'browser_launch', status: 'pass' }),
        expect.objectContaining({
          name: 'ghostty_web_available',
          status: 'pass',
        }),
        expect.objectContaining({ name: 'screenshot_viable', status: 'pass' }),
      ]),
    );
  });
});
