import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensurePlaywrightBrowsersPath,
  resolvePlaywrightBrowsersPath,
} from '../../../src/renderer/browserPath.js';

const temporaryHomes: string[] = [];

async function createHomeDirectory(prefix: string): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryHomes.push(home);
  return home;
}

async function createPlaywrightCacheHome(): Promise<{
  browserCachePath: string;
  home: string;
}> {
  const home = await createHomeDirectory('agent-tty-browser-path-');
  const browserCachePath = join(home, '.cache', 'ms-playwright');
  await mkdir(join(browserCachePath, 'chromium-1234'), { recursive: true });
  return { browserCachePath, home };
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe('Playwright browser path resolution', () => {
  it('prefers an explicit PLAYWRIGHT_BROWSERS_PATH override', () => {
    const resolution = resolvePlaywrightBrowsersPath({
      capturedHome: '/ignored-home',
      env: {
        PLAYWRIGHT_BROWSERS_PATH: '/custom/playwright-cache',
      },
      platform: 'linux',
    });

    expect(resolution).toEqual({
      path: '/custom/playwright-cache',
      source: 'env',
    });
  });

  it('resolves the default browser cache from the captured HOME when chromium exists', async () => {
    const { browserCachePath, home } = await createPlaywrightCacheHome();

    const resolution = resolvePlaywrightBrowsersPath({
      capturedHome: home,
      env: {},
      platform: 'linux',
    });

    expect(resolution).toEqual({
      path: browserCachePath,
      source: 'captured-home',
    });
  });

  it('resolves macOS browser cache from captured HOME', async () => {
    const home = await createHomeDirectory('agent-tty-browser-path-mac-');
    const macCachePath = join(home, 'Library', 'Caches', 'ms-playwright');
    await mkdir(join(macCachePath, 'chromium-1234'), { recursive: true });

    const resolution = resolvePlaywrightBrowsersPath({
      capturedHome: home,
      env: {},
      platform: 'darwin',
    });

    expect(resolution).toEqual({
      path: macCachePath,
      source: 'captured-home',
    });
  });

  it('sets PLAYWRIGHT_BROWSERS_PATH when the captured HOME fallback resolves', async () => {
    const { browserCachePath, home } = await createPlaywrightCacheHome();
    const env: NodeJS.ProcessEnv = {};

    const resolution = ensurePlaywrightBrowsersPath({
      capturedHome: home,
      env,
      platform: 'linux',
    });

    expect(resolution).toEqual({
      path: browserCachePath,
      source: 'captured-home',
    });
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(browserCachePath);
  });

  it('returns null for unsupported platforms', () => {
    const resolution = resolvePlaywrightBrowsersPath({
      capturedHome: '/home/user',
      env: {},
      platform: 'win32',
    });

    expect(resolution).toBeNull();
  });

  it('returns null without crashing when no browser cache is present', async () => {
    const home = await createHomeDirectory('agent-tty-browser-path-empty-');
    const env: NodeJS.ProcessEnv = {};

    const resolution = ensurePlaywrightBrowsersPath({
      capturedHome: home,
      env,
      platform: 'linux',
    });

    expect(resolution).toBeNull();
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });
});
