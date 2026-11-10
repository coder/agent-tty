import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  runCli,
} from '../helpers.js';

const CLI_TIMEOUT_MS = 60_000;

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

describe(
  'screenshot without a Chromium build for the bundled Playwright',
  { timeout: 120_000 },
  () => {
    let testHome = '';
    let emptyBrowserCache = '';
    let sessionId = '';

    beforeEach(async () => {
      // oxfmt-ignore
      testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-missing-chromium-home-')));
      // oxfmt-ignore
      emptyBrowserCache = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-missing-chromium-cache-')));
    });

    afterEach(async () => {
      destroySession(testHome, sessionId);
      await cleanupHome(testHome);
      await rm(emptyBrowserCache, { recursive: true, force: true });
      sessionId = '';
      testHome = '';
      emptyBrowserCache = '';
    });

    it('names the pinned install command instead of the bare one of Playwright', async () => {
      const packageJson = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { dependencies: { playwright: string } };
      const env = {
        AGENT_TTY_HOME: testHome,
        PLAYWRIGHT_BROWSERS_PATH: emptyBrowserCache,
      };
      sessionId = createSession(testHome, undefined, { env });

      const result = runCli(
        ['screenshot', sessionId, '--json'],
        env,
        CLI_TIMEOUT_MS,
      );

      expect(result.status).toBe(9);
      const { error } = JSON.parse(result.stdout) as ErrorEnvelope;
      expect(error.code).toBe('RPC_ERROR');
      // Playwright's own text has more lines, with a bare `npx playwright install`.
      expect(error.message).not.toContain('\n');
      expect(error.message).toMatch(
        /^failed to boot GhosttyWebBackend: browserType\.launch: Executable doesn't exist at /u,
      );
      expect(error.message).toContain(
        `. Run 'npx playwright@${packageJson.dependencies.playwright} install chromium' to install.`,
      );
    });
  },
);
