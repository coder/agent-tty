import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RecordDiffResult } from '../../src/protocol/messages.js';

import {
  cleanupHome,
  createSession,
  runCli,
  type SuccessEnvelope,
  type WaitResult,
} from '../helpers.js';

interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function waitForExit(testHome: string, sessionId: string): void {
  const result = runCli(
    ['wait', sessionId, '--exit', '--timeout', '10000', '--json'],
    { AGENT_TTY_HOME: testHome },
    15_000,
  );

  expect(result.status).toBe(0);
  const envelope = JSON.parse(result.stdout) as SuccessEnvelope<WaitResult>;
  expect(envelope.ok).toBe(true);
  expect(envelope.result.timedOut).toBe(false);
}

function runRecordDiff(
  testHome: string,
  args: string[],
): ReturnType<typeof runCli> {
  return runCli(['record', 'diff', ...args, '--json'], {
    AGENT_TTY_HOME: testHome,
  });
}

describe('record diff integration', { timeout: 120_000 }, () => {
  let testHome = '';

  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-record-diff-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('reports identical screens for sessions with identical output', () => {
    const command = ['/bin/sh', '-c', "printf 'alpha\\nbeta\\n'"];
    const sessionA = createSession(testHome, command);
    const sessionB = createSession(testHome, command);
    waitForExit(testHome, sessionA);
    waitForExit(testHome, sessionB);

    const result = runRecordDiff(testHome, [sessionA, sessionB]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<RecordDiffResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe('record diff');
    expect(envelope.result.identical).toBe(true);
    expect(envelope.result.diff).toEqual([]);
    expect(envelope.result.a.sessionId).toBe(sessionA);
    expect(envelope.result.b.sessionId).toBe(sessionB);
    expect(envelope.result.a.screenHash).toBe(envelope.result.b.screenHash);
    expect(envelope.result.a.screenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports an LCS line diff for sessions with differing output', () => {
    const sessionA = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'shared\\nOLD LINE\\n'",
    ]);
    const sessionB = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'shared\\nNEW LINE\\n'",
    ]);
    waitForExit(testHome, sessionA);
    waitForExit(testHome, sessionB);

    const result = runRecordDiff(testHome, [sessionA, sessionB]);

    expect(result.status).toBe(0);
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<RecordDiffResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.identical).toBe(false);
    expect(envelope.result.a.screenHash).not.toBe(envelope.result.b.screenHash);

    const deleted = envelope.result.diff.filter(
      (entry) => entry.op === 'delete',
    );
    const added = envelope.result.diff.filter((entry) => entry.op === 'add');
    expect(deleted.map((entry) => entry.text)).toContain('OLD LINE');
    expect(added.map((entry) => entry.text)).toContain('NEW LINE');
    expect(
      envelope.result.diff.some(
        (entry) => entry.op === 'equal' && entry.text === 'shared',
      ),
    ).toBe(true);
  });

  it('diffs the same session against an earlier --at-seq target', () => {
    const sessionId = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'first\\n'; sleep 0.3; printf 'second\\n'",
    ]);
    waitForExit(testHome, sessionId);

    // Sequence 0 is the first event of the log: replaying to it yields the
    // screen before 'second' was printed.
    const result = runRecordDiff(testHome, [
      sessionId,
      sessionId,
      '--at-seq-a',
      '0',
    ]);

    expect(result.status).toBe(0);
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<RecordDiffResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.identical).toBe(false);
    expect(envelope.result.a.capturedAtSeq).toBe(0);
    expect(envelope.result.b.capturedAtSeq).toBeGreaterThan(0);
    expect(
      envelope.result.diff
        .filter((entry) => entry.op === 'add')
        .map((entry) => entry.text),
    ).toContain('second');
  });

  it('reports identical blank screens for running sessions with no events yet', () => {
    // A freshly created quiet process has an empty event log; record diff must
    // synthesize the valid initial blank screen instead of failing replay.
    const sessionId = createSession(testHome, ['/bin/sleep', '60']);

    const result = runRecordDiff(testHome, [sessionId, sessionId]);

    expect(result.status).toBe(0);
    const envelope = JSON.parse(
      result.stdout,
    ) as SuccessEnvelope<RecordDiffResult>;
    expect(envelope.ok).toBe(true);
    expect(envelope.result.identical).toBe(true);
    expect(envelope.result.diff).toEqual([]);

    const destroyResult = runCli(['destroy', sessionId, '--force', '--json'], {
      AGENT_TTY_HOME: testHome,
    });
    expect(destroyResult.status).toBe(0);
  });

  it('rejects malformed --at-seq tokens instead of truncating them', () => {
    const command = ['/bin/sh', '-c', "printf 'x\\n'"];
    const sessionA = createSession(testHome, command);
    waitForExit(testHome, sessionA);

    for (const token of ['1.5', '2junk']) {
      const result = runRecordDiff(testHome, [
        sessionA,
        sessionA,
        '--at-seq-a',
        token,
      ]);

      expect(result.status).not.toBe(0);
      const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('INVALID_INPUT');
    }
  });

  it('fails with SESSION_NOT_FOUND for unknown sessions', () => {
    const command = ['/bin/sh', '-c', "printf 'x\\n'"];
    const sessionA = createSession(testHome, command);
    waitForExit(testHome, sessionA);

    const result = runRecordDiff(testHome, [
      sessionA,
      'session-does-not-exist',
    ]);

    expect(result.status).not.toBe(0);
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('rejects negative --at-seq values', () => {
    const command = ['/bin/sh', '-c', "printf 'x\\n'"];
    const sessionA = createSession(testHome, command);
    waitForExit(testHome, sessionA);

    const result = runRecordDiff(testHome, [
      sessionA,
      sessionA,
      '--at-seq-a',
      '-2',
    ]);

    expect(result.status).not.toBe(0);
    const envelope = JSON.parse(result.stdout) as ErrorEnvelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  it('prints a unified-style diff in human mode', () => {
    const sessionA = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'OLD\\n'",
    ]);
    const sessionB = createSession(testHome, [
      '/bin/sh',
      '-c',
      "printf 'NEW\\n'",
    ]);
    waitForExit(testHome, sessionA);
    waitForExit(testHome, sessionB);

    const result = runCli(['record', 'diff', sessionA, sessionB], {
      AGENT_TTY_HOME: testHome,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`--- ${sessionA} @seq `);
    expect(result.stdout).toContain(`+++ ${sessionB} @seq `);
    expect(result.stdout).toContain('-OLD');
    expect(result.stdout).toContain('+NEW');
  });
});
