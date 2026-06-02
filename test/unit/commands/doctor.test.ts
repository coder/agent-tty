import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDoctorLines,
  runArtifactAtomicityCheck,
  runBrowserCacheAccessibleCheck,
  runDoctorCheck,
  runDoctorChecks,
  runEventLogWritabilityCheck,
  runHomeIsolationCheck,
  runHomeWritableCheck,
  runPtySpawnCheck,
  runSocketViabilityCheck,
  type DoctorDependencies,
} from '../../../src/cli/commands/doctor.js';
import { resolveDefaultPlaywrightBrowsersPath } from '../../../src/renderer/browserPath.js';

const QUICK_TIMEOUT_MS = 5_000;

const NEW_DOCTOR_CHECKS = [
  { name: 'home_isolation', run: () => runHomeIsolationCheck() },
  { name: 'home-writable', run: () => runHomeWritableCheck() },
  { name: 'pty-spawn', run: () => runPtySpawnCheck() },
  { name: 'socket-viable', run: () => runSocketViabilityCheck() },
  {
    name: 'artifact-atomicity',
    run: () => runArtifactAtomicityCheck(),
  },
  {
    name: 'event-log-writable',
    run: () => runEventLogWritabilityCheck(),
  },
] as const;

const BROKEN_DOCTOR_CHECKS = [
  {
    name: 'home-writable',
    expectedMessage: 'home not writable',
    run: () =>
      runHomeWritableCheck({
        writeFile: (() =>
          Promise.reject(
            new Error('home not writable'),
          )) as DoctorDependencies['writeFile'],
      }),
  },
  {
    name: 'pty-spawn',
    expectedMessage: 'pty unavailable',
    run: () =>
      runPtySpawnCheck({
        createPty: (() => {
          throw new Error('pty unavailable');
        }) as DoctorDependencies['createPty'],
      }),
  },
  {
    name: 'socket-viable',
    expectedMessage: 'socket unavailable',
    run: () =>
      runSocketViabilityCheck({
        createSocketServer: (() => {
          throw new Error('socket unavailable');
        }) as DoctorDependencies['createSocketServer'],
      }),
  },
  {
    name: 'artifact-atomicity',
    expectedMessage: 'rename unavailable',
    run: () =>
      runArtifactAtomicityCheck({
        rename: (() =>
          Promise.reject(
            new Error('rename unavailable'),
          )) as DoctorDependencies['rename'],
      }),
  },
  {
    name: 'event-log-writable',
    expectedMessage: 'append unavailable',
    run: () =>
      runEventLogWritabilityCheck({
        writeFile: (() =>
          Promise.reject(
            new Error('append unavailable'),
          )) as DoctorDependencies['writeFile'],
      }),
  },
] as const;

let testHome = '';
let originalHome: string | undefined;
let originalPlaywrightBrowsersPath: string | undefined;

describe('doctor command', () => {
  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalPlaywrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    // oxfmt-ignore
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-doctor-home-')));
    process.env.AGENT_TTY_HOME = testHome;
  });

  afterEach(async () => {
    delete process.env.AGENT_TTY_HOME;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPlaywrightBrowsersPath === undefined) {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = originalPlaywrightBrowsersPath;
    }
    await rm(testHome, { recursive: true, force: true });
    testHome = '';
  });

  it('returns unique passing checks across environment and renderer groups', async () => {
    const result = await runDoctorChecks();
    const allChecks = [...result.checks.environment, ...result.checks.renderer];
    const checkNames = allChecks.map((check) => check.name);

    expect(result.ok).toBe(true);
    expect(result.checks.environment).toHaveLength(9);
    expect(result.checks.renderer).toHaveLength(6);
    expect(result.capabilities).toHaveLength(6);
    expect(result.capabilities.map((capability) => capability.name)).toEqual([
      'snapshot',
      'wait',
      'screenshot',
      'record-export-asciicast',
      'record-export-webm',
      'dashboard',
    ]);
    expect(result.capabilities.find(({ name }) => name === 'snapshot')).toEqual(
      {
        name: 'snapshot',
        status: 'available',
        reason: 'built-in capability',
        detail: 'available without external renderer dependencies',
      },
    );
    expect(
      result.capabilities.find(({ name }) => name === 'screenshot'),
    ).toMatchObject({
      name: 'screenshot',
      status: 'available',
      reason: 'renderer smoke checks passed',
    });
    expect(checkNames).toEqual(
      expect.arrayContaining([
        'home_isolation',
        'home-writable',
        'pty-spawn',
        'socket-viable',
        'artifact-atomicity',
        'event-log-writable',
        'browser_cache_accessible',
      ]),
    );
    expect(new Set(checkNames).size).toBe(checkNames.length);
    expect(allChecks.every((check) => check.status === 'pass')).toBe(true);
    expect(
      allChecks.every((check) => typeof check.durationMs === 'number'),
    ).toBe(true);
  });

  it.each(NEW_DOCTOR_CHECKS)(
    'passes $name in a healthy environment',
    async ({ name, run }) => {
      const result = await runDoctorCheck(name, run, QUICK_TIMEOUT_MS);

      expect(result).toMatchObject({
        name,
        status: 'pass',
      });
      expect(result.message.length).toBeGreaterThan(0);
    },
  );

  it('reports the default location when AGENT_TTY_HOME is not explicitly set', () => {
    delete process.env.AGENT_TTY_HOME;

    expect(runHomeIsolationCheck()).toBe(
      'agent-tty home uses default location',
    );
  });

  it('reports an explicit system home location when AGENT_TTY_HOME matches HOME', () => {
    process.env.HOME = testHome;
    process.env.AGENT_TTY_HOME = testHome;

    expect(runHomeIsolationCheck()).toBe(
      'agent-tty home is explicitly set to system home location',
    );
  });

  it('reports an isolated agent-tty home when AGENT_TTY_HOME differs from HOME', async () => {
    const systemHome = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-system-home-')),
    );
    process.env.HOME = systemHome;
    process.env.AGENT_TTY_HOME = testHome;

    try {
      expect(runHomeIsolationCheck()).toBe(
        `agent-tty home is isolated from system home: ${testHome}`,
      );
    } finally {
      await rm(systemHome, { recursive: true, force: true });
    }
  });

  it('passes browser_cache_accessible when PLAYWRIGHT_BROWSERS_PATH contains browser directories', async () => {
    const browserCachePath = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-browser-cache-')),
    );
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserCachePath;
    await mkdir(join(browserCachePath, 'chromium-1234'));

    try {
      const result = await runDoctorCheck(
        'browser_cache_accessible',
        (priorChecks) => runBrowserCacheAccessibleCheck(priorChecks),
        QUICK_TIMEOUT_MS,
        [
          {
            name: 'playwright_available',
            status: 'pass',
            message: 'available',
            durationMs: 1,
          },
        ],
      );

      expect(result).toMatchObject({
        name: 'browser_cache_accessible',
        status: 'pass',
        message: `browser cache accessible: ${browserCachePath}`,
      });
    } finally {
      await rm(browserCachePath, { recursive: true, force: true });
    }
  });

  it('fails browser_cache_accessible with an actionable message when the cache is missing', async () => {
    const missingCachePath = join(testHome, 'missing-browser-cache');
    process.env.PLAYWRIGHT_BROWSERS_PATH = missingCachePath;

    const result = await runDoctorCheck(
      'browser_cache_accessible',
      (priorChecks) => runBrowserCacheAccessibleCheck(priorChecks),
      QUICK_TIMEOUT_MS,
      [
        {
          name: 'playwright_available',
          status: 'pass',
          message: 'available',
          durationMs: 1,
        },
      ],
    );

    expect(result).toMatchObject({
      name: 'browser_cache_accessible',
      status: 'fail',
      message:
        `Playwright browser cache not found at ${missingCachePath}. ` +
        "Run 'npx playwright install chromium' to install.",
    });
  });

  it('uses the HOME-based default Playwright cache path when no override is set', async () => {
    const systemHome = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-system-home-')),
    );
    const browserCachePath = resolveDefaultPlaywrightBrowsersPath(
      systemHome,
      process.platform,
    );
    if (browserCachePath === null) {
      throw new Error(
        `expected a default Playwright browser cache path for ${process.platform}`,
      );
    }
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HOME = systemHome;
    await mkdir(join(browserCachePath, 'chromium-1234'), { recursive: true });

    try {
      const result = await runDoctorCheck(
        'browser_cache_accessible',
        (priorChecks) => runBrowserCacheAccessibleCheck(priorChecks),
        QUICK_TIMEOUT_MS,
        [
          {
            name: 'playwright_available',
            status: 'pass',
            message: 'available',
            durationMs: 1,
          },
        ],
      );

      expect(result).toMatchObject({
        name: 'browser_cache_accessible',
        status: 'pass',
        message: `browser cache accessible: ${browserCachePath}`,
      });
    } finally {
      await rm(systemHome, { recursive: true, force: true });
    }
  });

  it('skips browser_cache_accessible when playwright is unavailable', async () => {
    const result = await runDoctorCheck(
      'browser_cache_accessible',
      (priorChecks) => runBrowserCacheAccessibleCheck(priorChecks),
      QUICK_TIMEOUT_MS,
      [
        {
          name: 'playwright_available',
          status: 'fail',
          message: 'playwright missing',
          durationMs: 1,
        },
      ],
    );

    expect(result).toMatchObject({
      name: 'browser_cache_accessible',
      status: 'skip',
      message: 'playwright unavailable; browser cache check not attempted',
    });
  });

  it('kills the PTY when the outer doctor timeout expires', async () => {
    let onExitHandler:
      | ((event: { exitCode: number; signal?: number }) => void)
      | undefined;
    const kill = vi.fn(() => {
      onExitHandler?.({ exitCode: 130, signal: 15 });
    });

    const result = await runDoctorCheck(
      'pty-spawn',
      () =>
        runPtySpawnCheck({
          createPty: (() => ({
            onData: () => undefined,
            onExit: (
              handler: (event: { exitCode: number; signal?: number }) => void,
            ) => {
              onExitHandler = handler;
            },
            kill,
          })) as unknown as DoctorDependencies['createPty'],
        }),
      10,
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('pty-spawn timed out after 10ms');
    expect(kill).toHaveBeenCalled();
  });

  it.each(BROKEN_DOCTOR_CHECKS)(
    'fails $name gracefully when its dependency is broken',
    async ({ name, expectedMessage, run }) => {
      const result = await runDoctorCheck(name, run, QUICK_TIMEOUT_MS);

      expect(result).toMatchObject({
        name,
        status: 'fail',
      });
      expect(result.message).toContain(expectedMessage);
    },
  );

  it('formats grouped human-readable output', () => {
    const lines = buildDoctorLines({
      ok: false,
      capabilities: [],
      checks: {
        environment: [
          {
            name: 'node-runtime',
            status: 'pass',
            message: 'Node v24.1.0 ok',
            durationMs: 1,
          },
        ],
        renderer: [
          {
            name: 'playwright_available',
            status: 'fail',
            message: 'playwright missing',
            durationMs: 2,
          },
          {
            name: 'screenshot_viable',
            status: 'skip',
            message: 'not attempted',
            durationMs: 3,
          },
        ],
      },
    });

    expect(lines).toEqual([
      'Environment:',
      '  ✓ node: Node v24.1.0 ok',
      '',
      'Renderer:',
      '  ✗ playwright: playwright missing',
      '  ○ screenshot: not attempted',
    ]);
  });
});
