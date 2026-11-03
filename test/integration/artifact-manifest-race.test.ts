import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readArtifactManifest } from '../../src/storage/artifactManifest.js';
import { sessionDir } from '../../src/storage/sessionPaths.js';
import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
} from '../helpers.js';

const execFileAsync = promisify(execFile);
const MARKER = 'manifest-race-ready';
const ROUNDS = 3;

async function runCliAsync(testHome: string, args: string[]): Promise<number> {
  try {
    await execFileAsync(
      process.execPath,
      ['--import', 'tsx', './src/cli/main.ts', ...args, '--json'],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_TTY_HOME: testHome },
        timeout: 120_000,
      },
    );
    return 0;
  } catch (error) {
    const { code } = error as { code?: unknown };
    return typeof code === 'number' ? code : -1;
  }
}

describe(
  'artifact manifest with captures at the same time',
  { timeout: 600_000 },
  () => {
    let testHome = '';
    let sessionId = '';

    async function captureAtOnce(
      screenshots: number,
      exports: number,
    ): Promise<number[]> {
      return await Promise.all([
        ...Array.from({ length: screenshots }, () =>
          runCliAsync(testHome, ['screenshot', sessionId]),
        ),
        ...Array.from({ length: exports }, () =>
          runCliAsync(testHome, [
            'record',
            'export',
            sessionId,
            '--format',
            'asciicast',
          ]),
        ),
      ]);
    }

    async function countEntries(): Promise<Record<string, number>> {
      const manifest = await readArtifactManifest(
        sessionDir(testHome, sessionId),
      );
      const counts: Record<string, number> = {};
      for (const entry of manifest.artifacts) {
        counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
      }
      return counts;
    }

    beforeEach(async () => {
      // oxfmt-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-manifest-race-')));
      sessionId = createSession(testHome, [
        '/bin/sh',
        '-c',
        `echo ${MARKER}; exec cat`,
      ]);
      const wait = runCli(
        [
          'wait',
          sessionId,
          '--text',
          MARKER,
          '--timeout-ms',
          '20000',
          '--json',
        ],
        { AGENT_TTY_HOME: testHome },
        60_000,
      );
      expect(wait.status).toBe(0);
    }, 60_000);

    afterEach(async () => {
      destroySession(testHome, sessionId);
      await cleanupHome(testHome);
      sessionId = '';
      testHome = '';
    });

    it('keeps every entry of live screenshots and record exports', async () => {
      for (let round = 1; round <= ROUNDS; round += 1) {
        const codes = await captureAtOnce(4, 8);
        expect(codes).toEqual(Array.from({ length: 12 }, () => 0));
        expect(await countEntries()).toEqual({
          screenshot: 4 * round,
          recording: 8 * round,
        });
      }
    });

    it('keeps every entry of offline screenshots and record exports', async () => {
      destroySession(testHome, sessionId);
      for (let round = 1; round <= ROUNDS; round += 1) {
        const codes = await captureAtOnce(4, 4);
        expect(codes).toEqual(Array.from({ length: 8 }, () => 0));
        expect(await countEntries()).toEqual({
          screenshot: 4 * round,
          recording: 4 * round,
        });
      }
    });
  },
);
