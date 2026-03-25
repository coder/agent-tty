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
  type WaitResult,
} from './helpers.js';

interface CreateResult {
  sessionId: string;
}

interface InspectResult {
  session: SessionRecord;
}

interface SendKeysResult {
  accepted: string[];
  bytesWritten: number;
  seq: number;
}

function testEnv(home: string): Record<string, string> {
  return { AGENT_TERMINAL_HOME: home };
}

describe('hello-prompt e2e', { timeout: 30_000 }, () => {
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

  it('full interaction flow', async () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      ['create', '--', ...fixtureCommand('hello-prompt')],
      env,
    );

    expect(createEnvelope.ok).toBe(true);
    expect(createEnvelope.command).toBe('create');

    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const waitForReady = runCliJson<SuccessEnvelope<WaitResult>>(
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
    expect(waitForReady.ok).toBe(true);
    expect(waitForReady.command).toBe('wait');
    expect(waitForReady.result.timedOut).toBe(false);
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('READY> ');

    const typeEnvelope = runCliJson<SuccessEnvelope<Record<string, never>>>(
      ['type', sessionId, 'hello world'],
      env,
    );
    expect(typeEnvelope.ok).toBe(true);
    expect(typeEnvelope.command).toBe('type');
    expect(typeEnvelope.result).toEqual({});

    const sendKeysEnvelope = runCliJson<SuccessEnvelope<SendKeysResult>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(sendKeysEnvelope.ok).toBe(true);
    expect(sendKeysEnvelope.command).toBe('send-keys');
    expect(sendKeysEnvelope.result).toEqual({
      accepted: ['Enter'],
      bytesWritten: 1,
      seq: expect.any(Number) as number,
    });
    expect(sendKeysEnvelope.result.seq).toBeGreaterThanOrEqual(0);

    const waitForEcho = runCliJson<SuccessEnvelope<WaitResult>>(
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
    expect(waitForEcho.result.timedOut).toBe(false);
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('ECHO: hello world\nREADY> ');

    const inspectRunning = runCliJson<SuccessEnvelope<InspectResult>>(
      ['inspect', sessionId],
      env,
    );
    expect(inspectRunning.ok).toBe(true);
    expect(inspectRunning.command).toBe('inspect');
    expect(inspectRunning.result.session.status).toBe('running');
    expect(inspectRunning.result.session.exitCode).toBeNull();

    const typeExitEnvelope = runCliJson<SuccessEnvelope<Record<string, never>>>(
      ['type', sessionId, 'exit'],
      env,
    );
    expect(typeExitEnvelope.ok).toBe(true);
    expect(typeExitEnvelope.command).toBe('type');
    expect(typeExitEnvelope.result).toEqual({});

    const sendExitEnterEnvelope = runCliJson<SuccessEnvelope<SendKeysResult>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(sendExitEnterEnvelope.ok).toBe(true);
    expect(sendExitEnterEnvelope.command).toBe('send-keys');
    expect(sendExitEnterEnvelope.result).toEqual({
      accepted: ['Enter'],
      bytesWritten: 1,
      seq: expect.any(Number) as number,
    });
    expect(sendExitEnterEnvelope.result.seq).toBeGreaterThanOrEqual(0);

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
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('BYE\n');

    const inspectExited = runCliJson<SuccessEnvelope<InspectResult>>(
      ['inspect', sessionId],
      env,
    );
    expect(inspectExited.result.session.status).toBe('exited');
    expect(inspectExited.result.session.exitCode).toBe(0);

    const destroyEnvelope = runCliJson<
      SuccessEnvelope<{ sessionId: string; destroyed: boolean }>
    >(['destroy', sessionId, '--force'], env);
    expect(destroyEnvelope.ok).toBe(true);
    expect(destroyEnvelope.command).toBe('destroy');
    expect(destroyEnvelope.result.sessionId).toBe(sessionId);
    expect(destroyEnvelope.result.destroyed).toBe(true);

    createdSessionIds = createdSessionIds.filter(
      (value) => value !== sessionId,
    );
  });

  it('paste and exit-code', () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      ['create', '--', ...fixtureCommand('hello-prompt')],
      env,
    );
    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const waitForReady = runCliJson<SuccessEnvelope<WaitResult>>(
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
    expect(waitForReady.result.timedOut).toBe(false);

    const pasteEnvelope = runCliJson<SuccessEnvelope<Record<string, never>>>(
      ['paste', sessionId, 'exit-code 42'],
      env,
    );
    expect(pasteEnvelope.ok).toBe(true);
    expect(pasteEnvelope.command).toBe('paste');
    expect(pasteEnvelope.result).toEqual({});

    const sendKeysEnvelope = runCliJson<SuccessEnvelope<SendKeysResult>>(
      ['send-keys', sessionId, 'Enter'],
      env,
    );
    expect(sendKeysEnvelope.ok).toBe(true);
    expect(sendKeysEnvelope.command).toBe('send-keys');
    expect(sendKeysEnvelope.result).toEqual({
      accepted: ['Enter'],
      bytesWritten: 1,
      seq: expect.any(Number) as number,
    });
    expect(sendKeysEnvelope.result.seq).toBeGreaterThanOrEqual(0);

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
    expect(waitForExit.result.exitCode).toBe(42);
  });

  it('signal handling', async () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      ['create', '--', ...fixtureCommand('hello-prompt')],
      env,
    );
    const sessionId = createEnvelope.result.sessionId;
    createdSessionIds.push(sessionId);

    const waitForReady = runCliJson<SuccessEnvelope<WaitResult>>(
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
    expect(waitForReady.result.timedOut).toBe(false);

    const signalEnvelope = runCliJson<
      SuccessEnvelope<{ signal: string; delivered: boolean }>
    >(['signal', sessionId, 'SIGINT'], env);
    expect(signalEnvelope.ok).toBe(true);
    expect(signalEnvelope.command).toBe('signal');
    expect(signalEnvelope.result).toEqual({
      signal: 'SIGINT',
      delivered: true,
    });

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
    expect(waitForExit.result.exitCode).toBe(130);
    await expect(
      readOutput(testHome, sessionId).then((output) =>
        normalizeTerminalOutput(output),
      ),
    ).resolves.toContain('INTERRUPTED\n');
  });
});
