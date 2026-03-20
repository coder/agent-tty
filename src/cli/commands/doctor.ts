import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { emitSuccess } from '../output.js';

const COMMAND_NAME = 'doctor';
const CHECK_TIMEOUT_MS = 10_000;
const DOCTOR_GROUP_ORDER = ['environment', 'renderer'] as const;
const DOCTOR_GROUP_LABELS: Readonly<Record<DoctorCheckGroupName, string>> = Object.freeze({
  environment: 'Environment',
  renderer: 'Renderer',
});
const DOCTOR_CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'node-runtime': 'node',
  'cwd-access': 'cwd',
  'temp-dir': 'temp',
  playwright_available: 'playwright',
  browser_launch: 'browser',
  ghostty_web_available: 'ghostty-web',
  screenshot_viable: 'screenshot',
});

type DoctorCheckGroupName = 'environment' | 'renderer';
type DoctorCheckStatus = 'pass' | 'fail' | 'skip';
type DoctorCheckOperation = () => Promise<string> | string;

interface BrowserPageLike {
  screenshot(options: { path: string; timeout: number }): Promise<void>;
  setContent(
    html: string,
    options: { timeout: number; waitUntil: 'load' },
  ): Promise<void>;
}

interface BrowserLike {
  close(): Promise<void>;
  newPage(options: {
    viewport: {
      width: number;
      height: number;
    };
  }): Promise<BrowserPageLike>;
}

interface ChromiumLike {
  launch(options: { headless: boolean; timeout: number }): Promise<BrowserLike>;
}

interface PlaywrightModuleLike {
  chromium: ChromiumLike;
}

interface GhosttyWebModuleLike {
  init: unknown;
  Terminal: unknown;
}

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  durationMs?: number;
}

export interface DoctorCheckGroups {
  environment: DoctorCheck[];
  renderer: DoctorCheck[];
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheckGroups;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getCheckDurationMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

async function withTimeout<TResult>(
  operation: Promise<TResult>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<TResult> {
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, 'timeoutMs must be a positive integer');

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<TResult>((_resolvePromise, rejectPromise) => {
        timeoutHandle = setTimeout(() => {
          rejectPromise(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runDoctorCheck(
  name: string,
  operation: DoctorCheckOperation,
): Promise<DoctorCheck> {
  assert(name.length > 0, 'doctor check name must be a non-empty string');

  const startedAtMs = Date.now();
  try {
    const message = await withTimeout(
      Promise.resolve(operation()),
      CHECK_TIMEOUT_MS,
      `${name} timed out after ${String(CHECK_TIMEOUT_MS)}ms`,
    );
    assert(message.length > 0, 'doctor check success message must be non-empty');

    return {
      name,
      status: 'pass',
      message,
      durationMs: getCheckDurationMs(startedAtMs),
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    assert(message.length > 0, 'doctor check failure message must be non-empty');

    return {
      name,
      status: 'fail',
      message,
      durationMs: getCheckDurationMs(startedAtMs),
    };
  }
}

async function runCheckGroup(
  checks: ReadonlyArray<readonly [string, DoctorCheckOperation]>,
): Promise<DoctorCheck[]> {
  const results: DoctorCheck[] = [];
  for (const [name, operation] of checks) {
    results.push(await runDoctorCheck(name, operation));
  }

  return results;
}

function runNodeRuntimeCheck(): string {
  const majorVersion = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  assert(Number.isInteger(majorVersion), 'unable to parse Node runtime version');
  assert(majorVersion >= 24, `Node ${process.versions.node} requires 24+`);
  return `Node ${process.versions.node} ok`;
}

async function runWorkingDirectoryCheck(): Promise<string> {
  await access(process.cwd(), fsConstants.R_OK | fsConstants.W_OK);
  return `cwd read/write: ${process.cwd()}`;
}

async function runTemporaryDirectoryCheck(): Promise<string> {
  const directoryPrefix = join(tmpdir(), 'agent-terminal-');
  const temporaryDirectory = await mkdtemp(directoryPrefix);
  await rm(temporaryDirectory, { recursive: true, force: true });
  return `temp dir ok: ${tmpdir()}`;
}

async function importPlaywrightModule(): Promise<PlaywrightModuleLike> {
  return withTimeout(
    import('playwright') as Promise<PlaywrightModuleLike>,
    CHECK_TIMEOUT_MS,
    `playwright import timed out after ${String(CHECK_TIMEOUT_MS)}ms`,
  );
}

async function getPlaywrightChromium(): Promise<ChromiumLike> {
  const playwrightModule = await importPlaywrightModule();
  assert.equal(
    typeof playwrightModule.chromium.launch,
    'function',
    'playwright chromium.launch must be a function',
  );
  return playwrightModule.chromium;
}

async function runPlaywrightAvailableCheck(): Promise<string> {
  await getPlaywrightChromium();
  return 'available';
}

async function runBrowserLaunchCheck(): Promise<string> {
  const chromium = await getPlaywrightChromium();
  const browser = await chromium.launch({
    headless: true,
    timeout: CHECK_TIMEOUT_MS,
  });

  try {
    return 'chromium launches';
  } finally {
    await browser.close();
  }
}

async function importGhosttyWebModule(): Promise<GhosttyWebModuleLike> {
  return withTimeout(
    import('ghostty-web') as Promise<GhosttyWebModuleLike>,
    CHECK_TIMEOUT_MS,
    `ghostty-web import timed out after ${String(CHECK_TIMEOUT_MS)}ms`,
  );
}

async function runGhosttyWebAvailableCheck(): Promise<string> {
  const ghosttyModule = await importGhosttyWebModule();
  assert.equal(typeof ghosttyModule.init, 'function', 'ghostty-web init must be a function');
  assert.equal(
    typeof ghosttyModule.Terminal,
    'function',
    'ghostty-web Terminal must be a constructor',
  );
  return 'WASM available';
}

async function runScreenshotViabilityCheck(): Promise<string> {
  const chromium = await getPlaywrightChromium();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-terminal-doctor-'));
  const screenshotPath = join(temporaryDirectory, 'smoke-check.png');
  let browser: BrowserLike | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      timeout: CHECK_TIMEOUT_MS,
    });
    const page = await browser.newPage({
      viewport: {
        width: 320,
        height: 180,
      },
    });
    await page.setContent(
      '<!doctype html><html><body style="margin:0;background:#101820;color:#f2f2f2;font-family:sans-serif;">doctor smoke check</body></html>',
      {
        timeout: CHECK_TIMEOUT_MS,
        waitUntil: 'load',
      },
    );
    await page.screenshot({
      path: screenshotPath,
      timeout: CHECK_TIMEOUT_MS,
    });

    const screenshotInfo = await stat(screenshotPath);
    assert(screenshotInfo.size > 0, 'screenshot file must not be empty');
    return 'viable';
  } finally {
    if (browser !== null) {
      await browser.close().catch(() => undefined);
    }
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runDoctorChecks(): Promise<DoctorResult> {
  const environment = await runCheckGroup([
    ['node-runtime', runNodeRuntimeCheck],
    ['cwd-access', runWorkingDirectoryCheck],
    ['temp-dir', runTemporaryDirectoryCheck],
  ]);
  const renderer = await runCheckGroup([
    ['playwright_available', runPlaywrightAvailableCheck],
    ['browser_launch', runBrowserLaunchCheck],
    ['ghostty_web_available', runGhosttyWebAvailableCheck],
    ['screenshot_viable', runScreenshotViabilityCheck],
  ]);
  const allChecks = [...environment, ...renderer];
  const uniqueCheckNames = new Set(allChecks.map((check) => check.name));
  assert.equal(
    uniqueCheckNames.size,
    allChecks.length,
    'doctor check names must be unique',
  );

  return {
    ok: allChecks.every((check) => check.status !== 'fail'),
    checks: {
      environment,
      renderer,
    },
  };
}

export async function runBaselineDoctorChecks(): Promise<DoctorResult> {
  return runDoctorChecks();
}

function formatHumanCheckLine(check: DoctorCheck): string {
  const statusIcon =
    check.status === 'pass' ? '✓' : check.status === 'skip' ? '○' : '✗';
  const label = DOCTOR_CHECK_LABELS[check.name] ?? check.name;
  return `  ${statusIcon} ${label}: ${check.message}`;
}

export function buildDoctorLines(result: DoctorResult): string[] {
  const lines: string[] = [];

  for (const [index, groupName] of DOCTOR_GROUP_ORDER.entries()) {
    const checks = result.checks[groupName];
    lines.push(`${DOCTOR_GROUP_LABELS[groupName]}:`);
    lines.push(...checks.map((check) => formatHumanCheckLine(check)));
    if (index < DOCTOR_GROUP_ORDER.length - 1) {
      lines.push('');
    }
  }

  return lines;
}

export async function runDoctorCommand(options: {
  json: boolean;
}): Promise<void> {
  const result = await runDoctorChecks();
  const lines = buildDoctorLines(result);

  if (!result.ok) {
    process.exitCode = 1;
  }

  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines,
  });
}
