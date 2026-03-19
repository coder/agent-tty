import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createIsolatedHome,
  DEFAULT_IDLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  fixtureCommand,
  normalizeTerminalOutput,
  readOutput,
  runCli,
  runCliJson,
  type SessionRecord,
  type SuccessEnvelope,
} from './helpers.js';

interface CreateResult {
  sessionId: string;
}

interface InspectResult {
  session: SessionRecord;
}

interface WaitResult {
  exitCode?: number;
  timedOut: boolean;
}

function testEnv(home: string): Record<string, string> {
  return { AGENT_TERMINAL_HOME: home };
}

describe('resize-demo e2e', { timeout: 30_000 }, () => {
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

  it('initial size and resize', async () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      [
        'create',
        '--cols',
        '80',
        '--rows',
        '24',
        '--',
        ...fixtureCommand('resize-demo'),
      ],
      env,
    );
    expect(createEnvelope.ok).toBe(true);

    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const waitForInitialOutput = runCliJson<SuccessEnvelope<WaitResult>>(
      [
        'wait',
        sessionId,
        '--idle-ms',
        String(DEFAULT_IDLE_MS),
        '--timeout',
        String(DEFAULT_WAIT_TIMEOUT_MS),
      ],
      env,
    );
    expect(waitForInitialOutput.ok).toBe(true);
    expect(waitForInitialOutput.result.timedOut).toBe(false);
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('SIZE: 80x24\n');

    const resizeEnvelope = runCliJson<
      SuccessEnvelope<{ cols: number; rows: number }>
    >(['resize', sessionId, '--cols', '120', '--rows', '40'], env);
    expect(resizeEnvelope.ok).toBe(true);
    expect(resizeEnvelope.command).toBe('resize');
    expect(resizeEnvelope.result.cols).toBe(120);
    expect(resizeEnvelope.result.rows).toBe(40);

    const waitForResizeOutput = runCliJson<SuccessEnvelope<WaitResult>>(
      [
        'wait',
        sessionId,
        '--idle-ms',
        String(DEFAULT_IDLE_MS),
        '--timeout',
        String(DEFAULT_WAIT_TIMEOUT_MS),
      ],
      env,
    );
    expect(waitForResizeOutput.result.timedOut).toBe(false);
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('SIZE: 120x40\n');

    const typeQuitEnvelope = runCliJson<SuccessEnvelope<Record<string, never>>>(
      ['type', sessionId, 'quit'],
      env,
    );
    expect(typeQuitEnvelope.ok).toBe(true);
    expect(typeQuitEnvelope.command).toBe('type');
    expect(typeQuitEnvelope.result).toEqual({});

    const sendKeysEnvelope = runCliJson<SuccessEnvelope<Record<string, never>>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(sendKeysEnvelope.ok).toBe(true);
    expect(sendKeysEnvelope.command).toBe('send-keys');
    expect(sendKeysEnvelope.result).toEqual({});

    const waitForExit = runCliJson<SuccessEnvelope<WaitResult>>(
      [
        'wait',
        sessionId,
        '--exit',
        '--timeout',
        String(DEFAULT_WAIT_TIMEOUT_MS),
      ],
      env,
    );
    expect(waitForExit.ok).toBe(true);
    expect(waitForExit.result.timedOut).toBe(false);
    expect(waitForExit.result.exitCode).toBe(0);
  });

  it('inspect reflects resize', () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      ['create', '--', ...fixtureCommand('resize-demo')],
      env,
    );
    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const resizeEnvelope = runCliJson<
      SuccessEnvelope<{ cols: number; rows: number }>
    >(['resize', sessionId, '--cols', '100', '--rows', '50'], env);
    expect(resizeEnvelope.ok).toBe(true);
    expect(resizeEnvelope.result.cols).toBe(100);
    expect(resizeEnvelope.result.rows).toBe(50);

    const inspectEnvelope = runCliJson<SuccessEnvelope<InspectResult>>(
      ['inspect', sessionId],
      env,
    );
    expect(inspectEnvelope.ok).toBe(true);
    expect(inspectEnvelope.command).toBe('inspect');
    expect(inspectEnvelope.result.session.status).toBe('running');
    expect(inspectEnvelope.result.session.cols).toBe(100);
    expect(inspectEnvelope.result.session.rows).toBe(50);
  });
});
