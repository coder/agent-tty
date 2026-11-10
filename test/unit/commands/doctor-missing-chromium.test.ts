import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  runBrowserLaunchCheck,
  runDoctorCheck,
  runScreenshotViabilityCheck,
} from '../../../src/cli/commands/doctor.js';

const QUICK_TIMEOUT_MS = 5_000;

// What Playwright throws when the browser cache holds no Chromium build for
// its version, for example after a bare `npx playwright install chromium`
// outside a project. The real text draws a box around the last three lines.
const playwright = vi.hoisted(() => {
  const missingExecutableLine =
    "browserType.launch: Executable doesn't exist at /cache/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";
  return {
    launch: vi.fn<() => Promise<never>>(),
    missingExecutableLine,
    missingExecutableMessage: [
      missingExecutableLine,
      'Looks like Playwright was just installed or updated.',
      'Please run the following command to download new browsers:',
      '    npx playwright install',
    ].join('\n'),
  };
});

vi.mock('playwright', () => ({
  chromium: { launch: playwright.launch },
}));

describe('doctor with a Chromium executable that Playwright cannot find', () => {
  it.each([
    ['browser_launch', runBrowserLaunchCheck],
    ['screenshot_viable', runScreenshotViabilityCheck],
  ] as const)(
    'replaces the bare install command of Playwright with the pinned one in %s',
    async (name, runCheck) => {
      const packageJson = JSON.parse(
        await readFile(
          new URL('../../../package.json', import.meta.url),
          'utf8',
        ),
      ) as { dependencies: { playwright: string } };
      playwright.launch.mockRejectedValueOnce(
        new Error(playwright.missingExecutableMessage),
      );

      const result = await runDoctorCheck(
        name,
        () => runCheck(),
        QUICK_TIMEOUT_MS,
      );

      expect(result).toMatchObject({
        name,
        status: 'fail',
        message:
          `${playwright.missingExecutableLine}. ` +
          `Run 'npx playwright@${packageJson.dependencies.playwright} install chromium' to install.`,
      });
    },
  );

  it('keeps other launch errors as Playwright reports them', async () => {
    playwright.launch.mockRejectedValueOnce(
      new Error('browserType.launch: Timeout 10000ms exceeded.'),
    );

    const result = await runDoctorCheck(
      'browser_launch',
      () => runBrowserLaunchCheck(),
      QUICK_TIMEOUT_MS,
    );

    expect(result).toMatchObject({
      name: 'browser_launch',
      status: 'fail',
      message: 'browserType.launch: Timeout 10000ms exceeded.',
    });
  });
});
