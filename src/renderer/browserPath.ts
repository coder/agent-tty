import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export type PlaywrightBrowsersPathSource = 'env' | 'captured-home';

export interface PlaywrightBrowsersPathResolution {
  path: string;
  source: PlaywrightBrowsersPathSource;
}

export interface ResolvePlaywrightBrowsersPathOptions {
  env?: NodeJS.ProcessEnv;
  capturedHome?: string | undefined;
  platform?: NodeJS.Platform;
}

const CAPTURED_PROCESS_HOME = process.env.HOME;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function resolveDefaultPlaywrightBrowsersPath(
  capturedHome: string,
  platform: NodeJS.Platform,
): string | null {
  switch (platform) {
    case 'linux': {
      return join(capturedHome, '.cache', 'ms-playwright');
    }
    case 'darwin': {
      return join(capturedHome, 'Library', 'Caches', 'ms-playwright');
    }
    default: {
      return null;
    }
  }
}

function directoryContainsChromiumBrowser(browserCachePath: string): boolean {
  try {
    return readdirSync(browserCachePath, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && entry.name.startsWith('chromium'),
    );
  } catch {
    return false;
  }
}

export function resolvePlaywrightBrowsersPath(
  options: ResolvePlaywrightBrowsersPathOptions = {},
): PlaywrightBrowsersPathResolution | null {
  const env = options.env ?? process.env;
  const explicitOverride = env.PLAYWRIGHT_BROWSERS_PATH;
  if (isNonEmptyString(explicitOverride)) {
    return {
      path: explicitOverride,
      source: 'env',
    };
  }

  const capturedHome = options.capturedHome ?? CAPTURED_PROCESS_HOME;
  if (!isNonEmptyString(capturedHome)) {
    return null;
  }

  const browserCachePath = resolveDefaultPlaywrightBrowsersPath(
    capturedHome,
    options.platform ?? process.platform,
  );
  if (browserCachePath === null) {
    return null;
  }

  if (!directoryContainsChromiumBrowser(browserCachePath)) {
    return null;
  }

  return {
    path: browserCachePath,
    source: 'captured-home',
  };
}

export function ensurePlaywrightBrowsersPath(
  options: ResolvePlaywrightBrowsersPathOptions = {},
): PlaywrightBrowsersPathResolution | null {
  const env = options.env ?? process.env;
  const resolution = resolvePlaywrightBrowsersPath({
    ...options,
    env,
  });
  if (resolution?.source === 'captured-home') {
    env.PLAYWRIGHT_BROWSERS_PATH = resolution.path;
  }

  return resolution;
}
