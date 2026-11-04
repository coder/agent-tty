import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SnapshotResult } from '../../src/protocol/messages.js';
import {
  cleanupHome,
  createIsolatedHome,
  DEFAULT_CLI_TIMEOUT_MS,
  fixtureCommand,
  runCli,
  runCliJson,
  type SuccessEnvelope,
  type WaitResult,
} from './helpers.js';

interface CreateResult {
  sessionId: string;
}

const COLS = 300;
const ROWS = 100;

function testEnv(home: string): Record<string, string> {
  return { AGENT_TTY_HOME: home };
}

describe('large snapshot e2e', { timeout: 90_000 }, () => {
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

  it('returns a styled 300x100 snapshot with cells, larger than 1 MiB', () => {
    const env = testEnv(testHome);
    const createEnvelope = runCliJson<SuccessEnvelope<CreateResult>>(
      [
        'create',
        '--cols',
        String(COLS),
        '--rows',
        String(ROWS),
        '--',
        ...fixtureCommand('styled-fill'),
      ],
      env,
    );
    const { sessionId } = createEnvelope.result;
    createdSessionIds.push(sessionId);

    const waitEnvelope = runCliJson<SuccessEnvelope<WaitResult>>(
      ['wait', sessionId, '--text', 'FILL-DONE', '--timeout', '30000'],
      env,
    );
    expect(waitEnvelope.ok).toBe(true);

    // spawnSync keeps at most 1 MiB of stdout unless maxBuffer is raised.
    const snapshot = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        './src/cli/main.ts',
        'snapshot',
        sessionId,
        '--include-cells',
        '--json',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1_048_576,
        timeout: DEFAULT_CLI_TIMEOUT_MS,
      },
    );

    const envelope = JSON.parse(
      snapshot.stdout,
    ) as SuccessEnvelope<SnapshotResult> & {
      error?: unknown;
    };
    expect(envelope.error).toBeUndefined();
    expect(envelope.ok).toBe(true);
    expect(snapshot.status).toBe(0);
    expect(snapshot.stdout.length).toBeGreaterThan(1_048_576);
    const { result } = envelope;
    if (result.format !== 'structured') {
      throw new Error('expected a structured snapshot');
    }
    expect(result.cells).toHaveLength(ROWS);
    expect(result.cells?.[0]?.cells).toHaveLength(COLS);
    expect(result.cells?.[0]?.cells[0]).toMatchObject({
      char: 'a',
      bold: true,
    });
    expect(result.cells?.[0]?.cells[0]?.fg).toBeDefined();
    expect(result.cells?.[0]?.cells[0]?.bg).toBeDefined();
  });
});
