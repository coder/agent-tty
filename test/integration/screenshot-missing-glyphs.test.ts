import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
} from '../helpers.js';

const CLI_TIMEOUT_MS = 60_000;
// More distinct glyphs than one screenshot probes (MAX_GLYPH_PROBES).
const GLYPH_COUNT = 4600;

describe('screenshot missing-glyph output', { timeout: 120_000 }, () => {
  let testHome = '';
  let sessionId = '';

  beforeEach(async () => {
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-screenshot-glyphs-')));
  });

  afterEach(async () => {
    destroySession(testHome, sessionId);
    await cleanupHome(testHome);
    sessionId = '';
    testHome = '';
  });

  it('says the glyph check is incomplete when a screen has too many glyphs to probe', () => {
    sessionId = createSession(
      testHome,
      [
        process.execPath,
        '-e',
        `process.stdout.write(Array.from({ length: ${String(GLYPH_COUNT)} }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('') + '\\r\\ndone\\r\\n'); process.stdin.resume();`,
      ],
      { cols: 200, rows: 50 },
    );
    const wait = runCli(
      ['wait', sessionId, '--text', 'done', '--timeout-ms', '20000', '--json'],
      { AGENT_TTY_HOME: testHome },
      CLI_TIMEOUT_MS,
    );
    expect(wait.status).toBe(0);

    const result = runCli(
      ['screenshot', sessionId],
      { AGENT_TTY_HOME: testHome },
      CLI_TIMEOUT_MS,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')).toContain('Glyph check incomplete');
    expect(result.stdout).not.toContain('and more');
  });
});
