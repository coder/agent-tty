import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import process from 'node:process';

import type { CommandContext } from '../context.js';

import { emitSuccess } from '../output.js';
import type { CapabilityEntry } from '../../renderer/capabilities.js';

import { createPty } from '../../pty/createPty.js';
import { resolveDefaultPlaywrightBrowsersPath } from '../../renderer/browserPath.js';
import { discoverCapabilities } from '../../renderer/capabilities.js';
import {
  artifactPath,
  ensureArtifactsDir,
} from '../../storage/artifactPaths.js';
import { ensureHome, resolveHome } from '../../storage/home.js';
import {
  eventLogPath,
  sessionDir,
  socketPath,
} from '../../storage/sessionPaths.js';

const COMMAND_NAME = 'doctor';
const CHECK_TIMEOUT_MS = 10_000;
const QUICK_CHECK_TIMEOUT_MS = 5_000;
const DOCTOR_GROUP_ORDER = ['environment', 'renderer'] as const;
const DOCTOR_GROUP_LABELS: Readonly<Record<DoctorCheckGroupName, string>> =
  Object.freeze({
    environment: 'Environment',
    renderer: 'Renderer',
  });
const DOCTOR_CHECK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'node-runtime': 'node',
  'cwd-access': 'cwd',
  'temp-dir': 'temp',
  home_isolation: 'home-isolation',
  'home-writable': 'home-write',
  'pty-spawn': 'pty',
  'socket-viable': 'socket',
  'artifact-atomicity': 'artifacts',
  'event-log-writable': 'event-log',
  playwright_available: 'playwright',
  browser_cache_accessible: 'browser-cache',
  browser_launch: 'browser',
  ghostty_web_available: 'ghostty-web',
  screenshot_viable: 'screenshot',
});

let doctorResourceSequence = 0;

type DoctorCheckGroupName = 'environment' | 'renderer';
type DoctorCheckStatus = 'pass' | 'fail' | 'skip';

interface DoctorCheckSkipResult {
  status: 'skip';
  message: string;
}

type DoctorCheckOutcome = string | DoctorCheckSkipResult;
type DoctorCheckOperation = (
  priorChecks: ReadonlyArray<DoctorCheck>,
) => Promise<DoctorCheckOutcome> | DoctorCheckOutcome;
type DoctorCheckDefinition = readonly [
  name: string,
  operation: DoctorCheckOperation,
  timeoutMs?: number,
];

interface BrowserPageLike {
  screenshot(options: { path: string; timeout: number }): Promise<Buffer>;
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

export interface DoctorDependencies {
  createPty: typeof createPty;
  createSocketConnection: typeof createConnection;
  createSocketServer: typeof createServer;
  cwd: () => string;
  ensureArtifactsDir: typeof ensureArtifactsDir;
  ensureHome: typeof ensureHome;
  execPath: string;
  mkdir: typeof mkdir;
  now: () => number;
  pid: number;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

const DEFAULT_DOCTOR_DEPENDENCIES: DoctorDependencies = {
  createPty,
  createSocketConnection: createConnection,
  createSocketServer: createServer,
  cwd: () => process.cwd(),
  ensureArtifactsDir,
  ensureHome,
  execPath: process.execPath,
  mkdir,
  now: Date.now,
  pid: process.pid,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
};

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  durationMs: number;
}

export interface DoctorCheckGroups {
  environment: DoctorCheck[];
  renderer: DoctorCheck[];
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheckGroups;
  capabilities: CapabilityEntry[];
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

function skipDoctorCheck(message: string): DoctorCheckSkipResult {
  assert(message.length > 0, 'doctor check skip message must be non-empty');
  return {
    status: 'skip',
    message,
  };
}

function findDoctorCheck(
  checks: ReadonlyArray<DoctorCheck>,
  name: string,
): DoctorCheck | undefined {
  return checks.find((check) => check.name === name);
}

function resolveSystemHomeDirectory(): string {
  const configuredHome = process.env.HOME ?? homedir();
  assert(
    configuredHome.length > 0,
    'system home directory must be a non-empty path',
  );
  return normalize(configuredHome);
}

function resolvePlaywrightBrowserCachePath(): string {
  const overridePath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (overridePath !== undefined) {
    assert(
      overridePath.length > 0,
      'PLAYWRIGHT_BROWSERS_PATH must be a non-empty path when set',
    );
    return normalize(overridePath);
  }

  const browserCachePath = resolveDefaultPlaywrightBrowsersPath(
    resolveSystemHomeDirectory(),
    process.platform,
  );
  assert(
    browserCachePath !== null,
    `unsupported platform for default Playwright browser cache resolution: ${process.platform}`,
  );

  return normalize(browserCachePath);
}

function getDoctorDependencies(
  overrides: Partial<DoctorDependencies>,
): DoctorDependencies {
  return {
    ...DEFAULT_DOCTOR_DEPENDENCIES,
    ...overrides,
  };
}

function nextDoctorResourceSuffix(deps: DoctorDependencies): string {
  doctorResourceSequence += 1;
  assert(
    Number.isInteger(doctorResourceSequence) && doctorResourceSequence > 0,
    'doctor resource sequence must be a positive integer',
  );

  const timestamp = deps.now();
  assert(
    Number.isFinite(timestamp) && timestamp >= 0,
    'doctor timestamp must be a non-negative finite number',
  );
  assert(
    Number.isInteger(deps.pid) && deps.pid > 0,
    'doctor pid must be a positive integer',
  );

  return `${String(deps.pid)}-${Math.trunc(timestamp).toString(36)}-${String(doctorResourceSequence)}`;
}

interface CleanablePromise<TResult> extends Promise<TResult> {
  cleanup?: () => void | Promise<void>;
}

async function cleanupOperation<TResult>(
  operation: CleanablePromise<TResult>,
): Promise<void> {
  try {
    await operation.cleanup?.();
  } catch {
    // best-effort cleanup
  }
}

async function withTimeout<TResult>(
  operation: CleanablePromise<TResult>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<TResult> {
  assert(
    Number.isInteger(timeoutMs) && timeoutMs > 0,
    'timeoutMs must be a positive integer',
  );

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<TResult>((_resolvePromise, rejectPromise) => {
        timeoutHandle = setTimeout(() => {
          void cleanupOperation(operation).finally(() => {
            rejectPromise(new Error(timeoutMessage));
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function runDoctorCheck(
  name: string,
  operation: DoctorCheckOperation,
  timeoutMs = CHECK_TIMEOUT_MS,
  priorChecks: ReadonlyArray<DoctorCheck> = [],
): Promise<DoctorCheck> {
  assert(name.length > 0, 'doctor check name must be a non-empty string');

  const startedAtMs = Date.now();
  try {
    const outcome = await withTimeout(
      Promise.resolve(operation(priorChecks)),
      timeoutMs,
      `${name} timed out after ${String(timeoutMs)}ms`,
    );
    const status = typeof outcome === 'string' ? 'pass' : outcome.status;
    const message = typeof outcome === 'string' ? outcome : outcome.message;
    assert(
      message.length > 0,
      `doctor check ${status} message must be non-empty`,
    );

    return {
      name,
      status,
      message,
      durationMs: getCheckDurationMs(startedAtMs),
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    assert(
      message.length > 0,
      'doctor check failure message must be non-empty',
    );

    return {
      name,
      status: 'fail',
      message,
      durationMs: getCheckDurationMs(startedAtMs),
    };
  }
}

async function runCheckGroup(
  checks: ReadonlyArray<DoctorCheckDefinition>,
): Promise<DoctorCheck[]> {
  const results: DoctorCheck[] = [];
  for (const [name, operation, timeoutMs] of checks) {
    results.push(await runDoctorCheck(name, operation, timeoutMs, results));
  }

  return results;
}

function runNodeRuntimeCheck(): string {
  const majorVersion = Number.parseInt(
    process.versions.node.split('.')[0] ?? '',
    10,
  );
  assert(
    Number.isInteger(majorVersion),
    'unable to parse Node runtime version',
  );
  assert(majorVersion >= 24, `Node ${process.versions.node} requires 24+`);
  return `Node ${process.versions.node} ok`;
}

async function runWorkingDirectoryCheck(): Promise<string> {
  await access(process.cwd(), fsConstants.R_OK | fsConstants.W_OK);
  return `cwd read/write: ${process.cwd()}`;
}

async function runTemporaryDirectoryCheck(): Promise<string> {
  const directoryPrefix = join(tmpdir(), 'agent-tty-');
  const temporaryDirectory = await mkdtemp(directoryPrefix);
  await rm(temporaryDirectory, { recursive: true, force: true });
  return `temp dir ok: ${tmpdir()}`;
}

export function runHomeIsolationCheck(): string {
  const configuredHome = process.env.AGENT_TTY_HOME;
  if (configuredHome === undefined) {
    return 'agent-tty home uses default location';
  }

  const resolvedDoctorHome = resolveHome(configuredHome);
  const systemHome = resolveSystemHomeDirectory();
  if (resolvedDoctorHome === systemHome) {
    return 'agent-tty home is explicitly set to system home location';
  }

  return `agent-tty home is isolated from system home: ${resolvedDoctorHome}`;
}

export async function runHomeWritableCheck(
  overrides: Partial<DoctorDependencies> = {},
): Promise<string> {
  const deps = getDoctorDependencies(overrides);
  const home = await deps.ensureHome();
  assert(home.length > 0, 'doctor home must be a non-empty path');

  const temporaryFile = join(
    home,
    `.doctor-home-${nextDoctorResourceSuffix(deps)}.tmp`,
  );

  try {
    await deps.writeFile(temporaryFile, 'doctor home check\n', { flag: 'wx' });
    return `home writable: ${home}`;
  } finally {
    await deps.unlink(temporaryFile).catch(() => undefined);
  }
}

async function withDoctorSessionDirectory<TResult>(
  overrides: Partial<DoctorDependencies>,
  operation: (
    sessionDirectory: string,
    deps: DoctorDependencies,
  ) => Promise<TResult>,
): Promise<TResult> {
  const deps = getDoctorDependencies(overrides);
  const home = await deps.ensureHome();
  assert(home.length > 0, 'doctor home must be a non-empty path');

  const sessionDirectory = sessionDir(
    home,
    `doctor-${nextDoctorResourceSuffix(deps)}`,
  );
  await deps.mkdir(sessionDirectory, { recursive: true });

  try {
    return await operation(sessionDirectory, deps);
  } finally {
    await deps
      .rm(sessionDirectory, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

export function runPtySpawnCheck(
  overrides: Partial<DoctorDependencies> = {},
): Promise<string> {
  const deps = getDoctorDependencies(overrides);
  const cwd = deps.cwd();
  assert(cwd.length > 0, 'doctor cwd must be a non-empty path');
  assert(deps.execPath.length > 0, 'doctor execPath must be a non-empty path');

  let pty: ReturnType<DoctorDependencies['createPty']> | null = null;
  let output = '';

  const cleanupPty = () => {
    if (pty === null) {
      return;
    }

    try {
      pty.kill();
    } catch {
      // best-effort cleanup
    }
  };

  const spawnPromise = new Promise<void>((resolve, reject) => {
    pty = deps.createPty({
      command: [deps.execPath, '-e', "process.stdout.write('hello\\n')"],
      cwd,
      cols: 80,
      rows: 24,
      env: {},
      term: 'xterm-256color',
    });
    assert.equal(typeof pty.onData, 'function', 'PTY must support onData');
    assert.equal(typeof pty.onExit, 'function', 'PTY must support onExit');
    assert.equal(typeof pty.kill, 'function', 'PTY must support kill');

    pty.onData((chunk) => {
      output += chunk;
    });
    pty.onExit(({ exitCode, signal }) => {
      if (exitCode === 0 && output.includes('hello')) {
        resolve();
        return;
      }

      reject(
        new Error(
          `PTY spawn output mismatch (exitCode=${String(exitCode)}, signal=${String(signal)}, output=${JSON.stringify(output)})`,
        ),
      );
    });
  });

  const resultPromise = spawnPromise
    .then(() => `spawned ${deps.execPath}`)
    .finally(() => {
      cleanupPty();
    }) as CleanablePromise<string>;
  resultPromise.cleanup = cleanupPty;
  return resultPromise;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error instanceof Error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitForSocketConnect(client: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
}

async function waitForSocketClose(client: Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    client.once('close', () => resolve());
    client.end();
  });
}

export async function runSocketViabilityCheck(
  overrides: Partial<DoctorDependencies> = {},
): Promise<string> {
  return withDoctorSessionDirectory(
    overrides,
    async (sessionDirectory, deps) => {
      const socketFile = socketPath(sessionDirectory);
      await deps.mkdir(dirname(socketFile), { recursive: true });

      let server: Server | null = null;
      let client: Socket | null = null;
      let acceptedConnection = false;

      try {
        server = deps.createSocketServer();
        const serverInstance = server;
        serverInstance.on('connection', (socket) => {
          acceptedConnection = true;
          socket.on('error', () => undefined);
          socket.end();
        });

        await new Promise<void>((resolve, reject) => {
          serverInstance.once('error', reject);
          serverInstance.listen(socketFile, () => resolve());
        });

        client = deps.createSocketConnection(socketFile);
        await waitForSocketConnect(client);
        await waitForSocketClose(client);

        assert(
          acceptedConnection,
          `socket server never accepted a client connection for ${socketFile}`,
        );

        await closeServer(server);
        server = null;
        await deps.rm(socketFile, { force: true });
        return `socket ok: ${socketFile}`;
      } finally {
        client?.destroy();
        if (server !== null) {
          await closeServer(server).catch(() => undefined);
        }
        await deps.rm(socketFile, { force: true }).catch(() => undefined);
      }
    },
  );
}

export async function runArtifactAtomicityCheck(
  overrides: Partial<DoctorDependencies> = {},
): Promise<string> {
  return withDoctorSessionDirectory(
    overrides,
    async (sessionDirectory, deps) => {
      const artifactsDirectory =
        await deps.ensureArtifactsDir(sessionDirectory);
      assert(
        artifactsDirectory.length > 0,
        'artifact directory must be a non-empty path',
      );

      const suffix = nextDoctorResourceSuffix(deps);
      const temporaryArtifactPath = artifactPath(
        sessionDirectory,
        `.tmp-doctor-${suffix}.txt`,
      );
      const finalArtifactPath = artifactPath(
        sessionDirectory,
        `doctor-${suffix}.txt`,
      );
      const expectedContent = 'doctor artifact atomicity check\n';

      try {
        await deps.writeFile(temporaryArtifactPath, expectedContent, {
          flag: 'wx',
        });
        await deps.rename(temporaryArtifactPath, finalArtifactPath);
        const content = await deps.readFile(finalArtifactPath, 'utf8');
        assert.equal(
          content,
          expectedContent,
          `artifact content mismatch for ${finalArtifactPath}`,
        );
        return `atomic rename ok: ${artifactsDirectory}`;
      } finally {
        await deps
          .rm(temporaryArtifactPath, { force: true })
          .catch(() => undefined);
        await deps
          .rm(finalArtifactPath, { force: true })
          .catch(() => undefined);
      }
    },
  );
}

export async function runEventLogWritabilityCheck(
  overrides: Partial<DoctorDependencies> = {},
): Promise<string> {
  return withDoctorSessionDirectory(
    overrides,
    async (sessionDirectory, deps) => {
      const eventLogFile = eventLogPath(sessionDirectory);
      const firstLine = JSON.stringify({ type: 'doctor', pass: 1 });
      const secondLine = JSON.stringify({ type: 'doctor', pass: 2 });

      try {
        await deps.writeFile(eventLogFile, `${firstLine}\n`, { flag: 'a' });
        await deps.writeFile(eventLogFile, `${secondLine}\n`, { flag: 'a' });
        const content = await deps.readFile(eventLogFile, 'utf8');
        assert.equal(
          content,
          `${firstLine}\n${secondLine}\n`,
          `event log append mismatch for ${eventLogFile}`,
        );
        return `append ok: ${eventLogFile}`;
      } finally {
        await deps.rm(eventLogFile, { force: true }).catch(() => undefined);
      }
    },
  );
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

const PLAYWRIGHT_BROWSER_DIRECTORY_PATTERN =
  /^(?:chromium(?:_headless_shell)?|firefox|webkit|msedge)-/;

export async function runBrowserCacheAccessibleCheck(
  priorChecks: ReadonlyArray<DoctorCheck> = [],
): Promise<DoctorCheckOutcome> {
  const playwrightCheck = findDoctorCheck(priorChecks, 'playwright_available');
  if (playwrightCheck?.status === 'fail') {
    return skipDoctorCheck(
      'playwright unavailable; browser cache check not attempted',
    );
  }

  const browserCachePath = resolvePlaywrightBrowserCachePath();
  try {
    await access(browserCachePath, fsConstants.R_OK | fsConstants.X_OK);
    const cacheEntries = await readdir(browserCachePath, {
      withFileTypes: true,
    });
    const browserDirectory = cacheEntries.find(
      (entry) =>
        entry.isDirectory() &&
        PLAYWRIGHT_BROWSER_DIRECTORY_PATTERN.test(entry.name),
    );
    assert(
      browserDirectory !== undefined,
      `Playwright browser cache not found at ${browserCachePath}. Run 'npx playwright install chromium' to install.`,
    );
  } catch (error) {
    throw new Error(
      `Playwright browser cache not found at ${browserCachePath}. Run 'npx playwright install chromium' to install.`,
      { cause: error },
    );
  }

  return `browser cache accessible: ${browserCachePath}`;
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
  assert.equal(
    typeof ghosttyModule.init,
    'function',
    'ghostty-web init must be a function',
  );
  assert.equal(
    typeof ghosttyModule.Terminal,
    'function',
    'ghostty-web Terminal must be a constructor',
  );
  return 'WASM available';
}

async function runScreenshotViabilityCheck(): Promise<string> {
  const chromium = await getPlaywrightChromium();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-tty-doctor-'));
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
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export async function runDoctorChecks(): Promise<DoctorResult> {
  const environment = await runCheckGroup([
    ['node-runtime', () => runNodeRuntimeCheck()],
    ['cwd-access', () => runWorkingDirectoryCheck()],
    ['temp-dir', () => runTemporaryDirectoryCheck()],
    ['home_isolation', () => runHomeIsolationCheck(), QUICK_CHECK_TIMEOUT_MS],
    ['home-writable', () => runHomeWritableCheck(), QUICK_CHECK_TIMEOUT_MS],
    ['pty-spawn', () => runPtySpawnCheck(), QUICK_CHECK_TIMEOUT_MS],
    ['socket-viable', () => runSocketViabilityCheck(), QUICK_CHECK_TIMEOUT_MS],
    [
      'artifact-atomicity',
      () => runArtifactAtomicityCheck(),
      QUICK_CHECK_TIMEOUT_MS,
    ],
    [
      'event-log-writable',
      () => runEventLogWritabilityCheck(),
      QUICK_CHECK_TIMEOUT_MS,
    ],
  ]);
  const renderer = await runCheckGroup([
    ['playwright_available', () => runPlaywrightAvailableCheck()],
    [
      'browser_cache_accessible',
      (priorChecks) => runBrowserCacheAccessibleCheck(priorChecks),
    ],
    ['browser_launch', () => runBrowserLaunchCheck()],
    ['ghostty_web_available', () => runGhosttyWebAvailableCheck()],
    ['screenshot_viable', () => runScreenshotViabilityCheck()],
  ]);
  const allChecks = [...environment, ...renderer];
  const uniqueCheckNames = new Set(allChecks.map((check) => check.name));
  assert.equal(
    uniqueCheckNames.size,
    allChecks.length,
    'doctor check names must be unique',
  );

  const capabilities = await discoverCapabilities('full', {
    rendererChecks: renderer,
  });

  return {
    ok: allChecks.every((check) => check.status !== 'fail'),
    checks: {
      environment,
      renderer,
    },
    capabilities,
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
  context: CommandContext;
  json: boolean;
}): Promise<void> {
  options.context.logger.debug('running doctor checks');
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
