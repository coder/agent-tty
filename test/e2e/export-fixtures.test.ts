import { readFile, stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  InspectResult,
  RecordExportResult,
  ScreenshotResult,
  SnapshotResult,
  WaitForRenderResult,
} from '../../src/protocol/messages.js';
import { readArtifactManifest } from '../../src/storage/artifactManifest.js';
import { sessionDir } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createIsolatedHome,
  DEFAULT_IDLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  fixtureCommand,
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
const PNG_MAGIC_HEX = '89504e470d0a1a0a';
const RENDER_WAIT_TIMEOUT_MS = 10_000;
const WEBM_TIMEOUT_MS = 120_000;

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

function parseAsciicast(contents: string): unknown[] {
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function asciicastOutputText(contents: string): string {
  const parsedLines = parseAsciicast(contents);

  return parsedLines
    .slice(1)
    .filter(
      (line): line is [number, string, string] =>
        Array.isArray(line) &&
        line.length === 3 &&
        line[1] === 'o' &&
        typeof line[2] === 'string',
    )
    .map((line) => line[2])
    .join('');
}

function createFixtureSession(
  home: string,
  createdSessionIds: string[],
  appName: 'hello-prompt' | 'color-grid' | 'alt-screen-demo' | 'crash-demo',
): string {
  const env = testEnv(home);
  const createEnvelope = runCliEnvelope<CreateResult>(
    ['create', '--', ...fixtureCommand(appName)],
    env,
  );

  expect(createEnvelope.ok).toBe(true);
  expect(createEnvelope.command).toBe('create');

  const sessionId = createEnvelope.result.sessionId;
  createdSessionIds.push(sessionId);
  return sessionId;
}

function waitForIdle(
  sessionId: string,
  env: Record<string, string>,
  timeout = DEFAULT_WAIT_TIMEOUT_MS,
): SuccessEnvelope<WaitResult> {
  const envelope = runCliEnvelope<WaitResult>(
    [
      'wait',
      sessionId,
      '--idle-ms',
      String(DEFAULT_IDLE_MS),
      '--timeout',
      String(timeout),
    ],
    env,
  );

  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe('wait');
  expect(envelope.result.timedOut).toBe(false);

  return envelope;
}

function waitForExit(
  sessionId: string,
  env: Record<string, string>,
  timeout = DEFAULT_WAIT_TIMEOUT_MS,
): SuccessEnvelope<WaitResult> {
  const envelope = runCliEnvelope<WaitResult>(
    ['wait', sessionId, '--exit', '--timeout', String(timeout)],
    env,
  );

  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe('wait');
  expect(envelope.result.timedOut).toBe(false);

  return envelope;
}

function waitForVisibleText(
  sessionId: string,
  env: Record<string, string>,
  text: string,
  timeout = RENDER_WAIT_TIMEOUT_MS,
): SuccessEnvelope<WaitForRenderResult> {
  const envelope = runCliEnvelope<WaitForRenderResult>(
    ['wait', sessionId, '--text', text, '--timeout', String(timeout)],
    env,
    timeout + 10_000,
  );

  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe('wait');
  expect(envelope.result.matched).toBe(true);
  expect(envelope.result.timedOut).toBe(false);
  expect(envelope.result.matchedText).toBe(text);

  return envelope;
}

describe('export fixture e2e', { timeout: 180_000 }, () => {
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

  it('captures a color-grid screenshot with a non-trivial PNG artifact', async () => {
    const env = testEnv(testHome);
    const sessionId = createFixtureSession(
      testHome,
      createdSessionIds,
      'color-grid',
    );

    waitForIdle(sessionId, env, 5_000);
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('COLOR GRID FIXTURE');

    const screenshotEnvelope = runCliEnvelope<ScreenshotResult>(
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
  });

  it('exports color-grid output as an asciicast with ANSI color sequences', async () => {
    const env = testEnv(testHome);
    const sessionId = createFixtureSession(
      testHome,
      createdSessionIds,
      'color-grid',
    );

    const exitEnvelope = waitForExit(sessionId, env, 10_000);
    expect(exitEnvelope.result.exitCode).toBe(0);

    const exportEnvelope = runCliEnvelope<RecordExportResult>(
      ['record', 'export', sessionId, '--format', 'asciicast'],
      env,
    );
    expect(exportEnvelope.ok).toBe(true);
    expect(exportEnvelope.command).toBe('record export');
    expect(exportEnvelope.result.sessionId).toBe(sessionId);
    expect(exportEnvelope.result.format).toBe('asciicast');
    expect(exportEnvelope.result.artifactPath).toMatch(/\.cast$/);

    const asciicastContents = await readFile(
      exportEnvelope.result.artifactPath,
      'utf8',
    );
    expect(asciicastContents).toContain('COLOR GRID FIXTURE');
    expect(asciicastOutputText(asciicastContents)).toContain(
      'COLOR GRID COMPLETE',
    );
    const escapedAnsiFragments = [
      String.raw`\u001b[38;5;`,
      String.raw`\u001b[48;5;`,
      String.raw`\u001b[38;2;`,
      String.raw`\u001b[48;2;`,
    ];

    expect(
      escapedAnsiFragments.some((fragment) =>
        asciicastContents.includes(fragment),
      ),
    ).toBe(true);
  });

  it('captures alt-screen content live and replays the restored main screen after exit', () => {
    const env = testEnv(testHome);
    const sessionId = createFixtureSession(
      testHome,
      createdSessionIds,
      'alt-screen-demo',
    );

    waitForVisibleText(sessionId, env, 'MAIN SCREEN READY');
    const initialSnapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId, '--format', 'text'],
      env,
    );
    expect(initialSnapshotEnvelope.ok).toBe(true);
    expect(initialSnapshotEnvelope.command).toBe('snapshot');
    expect(initialSnapshotEnvelope.result.format).toBe('text');
    if (initialSnapshotEnvelope.result.format !== 'text') {
      throw new Error(
        'expected a text snapshot for the initial alt-screen state',
      );
    }
    expect(initialSnapshotEnvelope.result.text).toContain('MAIN SCREEN READY');
    expect(initialSnapshotEnvelope.result.text).not.toContain(
      'ALT SCREEN ACTIVE',
    );

    const enterAltScreenEnvelope = runCliEnvelope<Record<string, never>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(enterAltScreenEnvelope.ok).toBe(true);
    expect(enterAltScreenEnvelope.command).toBe('send-keys');

    waitForVisibleText(sessionId, env, 'ALT SCREEN ACTIVE');
    const altSnapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId, '--format', 'text'],
      env,
    );
    expect(altSnapshotEnvelope.result.format).toBe('text');
    if (altSnapshotEnvelope.result.format !== 'text') {
      throw new Error(
        'expected a text snapshot while the alt screen is active',
      );
    }
    expect(altSnapshotEnvelope.result.text).toContain('ALT SCREEN ACTIVE');
    expect(altSnapshotEnvelope.result.text).not.toContain(
      'BACK ON MAIN SCREEN',
    );

    const exitAltScreenEnvelope = runCliEnvelope<Record<string, never>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(exitAltScreenEnvelope.ok).toBe(true);
    expect(exitAltScreenEnvelope.command).toBe('send-keys');

    const exitEnvelope = waitForExit(sessionId, env, 10_000);
    expect(exitEnvelope.result.exitCode).toBe(0);

    const postExitSnapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId, '--format', 'text'],
      env,
    );
    expect(postExitSnapshotEnvelope.ok).toBe(true);
    expect(postExitSnapshotEnvelope.command).toBe('snapshot');
    expect(postExitSnapshotEnvelope.result.format).toBe('text');
    if (postExitSnapshotEnvelope.result.format !== 'text') {
      throw new Error(
        'expected a text snapshot after the alt-screen session exited',
      );
    }
    expect(postExitSnapshotEnvelope.result.text).toContain('MAIN SCREEN READY');
    expect(postExitSnapshotEnvelope.result.text).toContain(
      'BACK ON MAIN SCREEN',
    );
    expect(postExitSnapshotEnvelope.result.text).not.toContain(
      'ALT SCREEN ACTIVE',
    );
  });

  it('supports post-mortem snapshot, screenshot, and asciicast export after a crash', async () => {
    const env = testEnv(testHome);
    const sessionId = createFixtureSession(
      testHome,
      createdSessionIds,
      'crash-demo',
    );

    const exitEnvelope = waitForExit(sessionId, env, 10_000);
    expect(exitEnvelope.result.exitCode).toBe(1);

    const inspectEnvelope = runCliEnvelope<InspectResult>(
      ['inspect', sessionId],
      env,
    );
    expect(inspectEnvelope.ok).toBe(true);
    expect(inspectEnvelope.command).toBe('inspect');
    expect(inspectEnvelope.result.session.status).toBe('exited');
    expect(inspectEnvelope.result.session.exitCode).toBe(1);

    const snapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId, '--format', 'text'],
      env,
    );
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.result.format).toBe('text');
    if (snapshotEnvelope.result.format !== 'text') {
      throw new Error(
        'expected a text snapshot for the crash-demo post-mortem replay',
      );
    }
    expect(snapshotEnvelope.result.text).toContain('CRASH DEMO START');
    expect(snapshotEnvelope.result.text).toContain('CRASH DEMO EXITING');

    const screenshotEnvelope = runCliEnvelope<ScreenshotResult>(
      ['screenshot', sessionId],
      env,
    );
    expect(screenshotEnvelope.ok).toBe(true);
    expect(screenshotEnvelope.command).toBe('screenshot');
    expect(screenshotEnvelope.result.pngSizeBytes).toBeGreaterThan(0);

    const screenshotBytes = await readFile(
      screenshotEnvelope.result.artifactPath,
    );
    expect(screenshotBytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC_HEX);

    const exportEnvelope = runCliEnvelope<RecordExportResult>(
      ['record', 'export', sessionId, '--format', 'asciicast'],
      env,
    );
    expect(exportEnvelope.ok).toBe(true);
    expect(exportEnvelope.result.format).toBe('asciicast');

    const asciicastContents = await readFile(
      exportEnvelope.result.artifactPath,
      'utf8',
    );
    expect(asciicastOutputText(asciicastContents)).toContain(
      'Persist this line for post-mortem replay.',
    );

    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual([
      'snapshot',
      'screenshot',
      'recording',
    ]);
  });

  it('runs the full export pipeline and records every artifact in the manifest', async () => {
    const env = testEnv(testHome);
    const sessionId = createFixtureSession(
      testHome,
      createdSessionIds,
      'hello-prompt',
    );

    waitForIdle(sessionId, env, 10_000);

    const typeResult = runCliEnvelope<Record<string, never>>(
      ['type', sessionId, 'export pipeline'],
      env,
    );
    expect(typeResult.ok).toBe(true);
    expect(typeResult.command).toBe('type');

    const sendKeysResult = runCliEnvelope<Record<string, never>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(sendKeysResult.ok).toBe(true);
    expect(sendKeysResult.command).toBe('send-keys');

    waitForVisibleText(sessionId, env, 'ECHO: export pipeline');
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('ECHO: export pipeline\nREADY> ');

    const snapshotEnvelope = runCliEnvelope<SnapshotResult>(
      ['snapshot', sessionId],
      env,
    );
    expect(snapshotEnvelope.ok).toBe(true);
    expect(snapshotEnvelope.command).toBe('snapshot');

    const screenshotEnvelope = runCliEnvelope<ScreenshotResult>(
      ['screenshot', sessionId],
      env,
    );
    expect(screenshotEnvelope.ok).toBe(true);
    expect(screenshotEnvelope.command).toBe('screenshot');

    const asciicastEnvelope = runCliEnvelope<RecordExportResult>(
      ['record', 'export', sessionId, '--format', 'asciicast'],
      env,
    );
    expect(asciicastEnvelope.ok).toBe(true);
    expect(asciicastEnvelope.command).toBe('record export');
    expect(asciicastEnvelope.result.format).toBe('asciicast');

    const destroyEnvelope = runCliEnvelope<{
      sessionId: string;
      destroyed: boolean;
    }>(['destroy', sessionId, '--force'], env);
    expect(destroyEnvelope.ok).toBe(true);
    expect(destroyEnvelope.command).toBe('destroy');
    expect(destroyEnvelope.result).toEqual({
      sessionId,
      destroyed: true,
    });

    const inspectEnvelope = runCliEnvelope<InspectResult>(
      ['inspect', sessionId],
      env,
    );
    expect(inspectEnvelope.result.session.status).toBe('exited');

    const webmEnvelope = runCliEnvelope<RecordExportResult>(
      ['record', 'export', sessionId, '--format', 'webm'],
      env,
      WEBM_TIMEOUT_MS,
    );
    expect(webmEnvelope.ok).toBe(true);
    expect(webmEnvelope.command).toBe('record export');
    expect(webmEnvelope.result.format).toBe('webm');
    expect(webmEnvelope.result.bytes).toBeGreaterThan(0);

    const webmStats = await stat(webmEnvelope.result.artifactPath);
    expect(webmStats.size).toBe(webmEnvelope.result.bytes);

    const manifest = await readArtifactManifest(
      sessionDir(testHome, sessionId),
    );
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual([
      'snapshot',
      'screenshot',
      'recording',
      'video',
    ]);

    const snapshotArtifact = manifest.artifacts.find(
      (artifact) => artifact.kind === 'snapshot',
    );
    const screenshotArtifact = manifest.artifacts.find(
      (artifact) => artifact.kind === 'screenshot',
    );
    const recordingArtifact = manifest.artifacts.find(
      (artifact) => artifact.kind === 'recording',
    );
    const videoArtifact = manifest.artifacts.find(
      (artifact) => artifact.kind === 'video',
    );

    expect(snapshotArtifact).toMatchObject({
      kind: 'snapshot',
      sessionId,
      capturedAtSeq: snapshotEnvelope.result.capturedAtSeq,
    });
    expect(screenshotArtifact).toMatchObject({
      kind: 'screenshot',
      sessionId,
      capturedAtSeq: screenshotEnvelope.result.capturedAtSeq,
    });
    expect(recordingArtifact).toMatchObject({
      kind: 'recording',
      sessionId,
      sha256: asciicastEnvelope.result.sha256,
      bytes: asciicastEnvelope.result.bytes,
    });
    expect(recordingArtifact?.filename).toMatch(/\.cast$/u);
    expect(videoArtifact).toMatchObject({
      kind: 'video',
      sessionId,
      sha256: webmEnvelope.result.sha256,
      bytes: webmEnvelope.result.bytes,
    });
    expect(videoArtifact?.filename).toMatch(/\.webm$/u);

    createdSessionIds = createdSessionIds.filter(
      (value) => value !== sessionId,
    );
  });
});
