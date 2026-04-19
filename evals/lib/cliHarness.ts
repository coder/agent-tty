import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import type {
  EvalCliOptions,
  EvalCliResult,
  EvalEventRecord,
} from './types.js';
import type { ResolvedWorkspacePlan } from '../workspaces/types.js';

import { EvalCliResultSchema } from './schemas.js';
import {
  EventRecordSchema,
  SessionRecordSchema,
} from '../../src/protocol/schemas.js';
import {
  eventLogPath,
  manifestPath,
  sessionDir,
} from '../../src/storage/sessionPaths.js';
import { assertString, invariant } from '../../src/util/assert.js';

const CLI_ENTRYPOINT = 'src/cli/main.ts';
const CLI_JSON_FLAG = '--json';
const COMMAND_SEPARATOR = '--';
const DEFAULT_CLI_TIMEOUT_MS = 30_000;
const EVAL_HOME_PREFIX = 'agent-tty-evals-home-';
const SAFE_FIXTURE_APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

function assertAbsolutePath(pathValue: string, label: string): void {
  assertString(pathValue, `${label} must be a string`);
  invariant(pathValue.length > 0, `${label} must be a non-empty string`);
  invariant(isAbsolute(pathValue), `${label} must be an absolute path`);
}

function assertNonEmptyString(value: string, label: string): void {
  assertString(value, `${label} must be a string`);
  invariant(value.length > 0, `${label} must be a non-empty string`);
}

function assertStringArray(values: readonly string[], label: string): void {
  invariant(Array.isArray(values), `${label} must be an array of strings`);

  for (const value of values) {
    assertString(value, `${label} must contain only strings`);
  }
}

function assertStringRecord(
  value: Readonly<Record<string, string>> | undefined,
  label: string,
): void {
  if (value === undefined) {
    return;
  }

  invariant(!Array.isArray(value), `${label} must be a record of strings`);

  for (const [key, entryValue] of Object.entries(value)) {
    assertNonEmptyString(key, `${label} keys`);
    assertString(entryValue, `${label}.${key} must be a string`);
  }
}

interface PreparedWorkspaceInput {
  homeDir: string;
  plan: ResolvedWorkspacePlan;
  effectiveEnv: Readonly<Record<string, string>>;
  defaultCwd: string;
}

async function assertExistingDirectory(
  pathValue: string,
  label: string,
): Promise<void> {
  assertAbsolutePath(pathValue, label);

  const stats = await stat(pathValue).catch((error: unknown) => {
    throw new Error(`${label} must exist at ${pathValue}`, { cause: error });
  });
  invariant(stats.isDirectory(), `${label} must be a directory`);
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

async function copyDirectoryContents(
  sourceDir: string,
  destinationDir: string,
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    await cp(join(sourceDir, entry.name), join(destinationDir, entry.name), {
      recursive: entry.isDirectory(),
      errorOnExist: false,
      force: true,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCliFlagBeforeSeparator(
  args: readonly string[],
  flag: string,
): boolean {
  const separatorIndex = args.indexOf(COMMAND_SEPARATOR);
  const optionArgs =
    separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  return optionArgs.includes(flag);
}

function withJsonFlag(args: string[], json: boolean): string[] {
  const normalizedArgs = [...args];
  if (!json || hasCliFlagBeforeSeparator(normalizedArgs, CLI_JSON_FLAG)) {
    return normalizedArgs;
  }

  const separatorIndex = normalizedArgs.indexOf(COMMAND_SEPARATOR);
  if (separatorIndex === -1) {
    return [...normalizedArgs, CLI_JSON_FLAG];
  }

  return [
    ...normalizedArgs.slice(0, separatorIndex),
    CLI_JSON_FLAG,
    ...normalizedArgs.slice(separatorIndex),
  ];
}

function collectManifestPids(rawManifest: unknown): number[] {
  const pids = new Set<number>();
  const parsedManifest = SessionRecordSchema.safeParse(rawManifest);

  if (parsedManifest.success) {
    for (const pid of [
      parsedManifest.data.hostPid,
      parsedManifest.data.childPid,
    ]) {
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  }

  if (isRecord(rawManifest)) {
    for (const pidKey of ['pid', 'hostPid', 'childPid'] as const) {
      const pid = rawManifest[pidKey];
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  }

  return [...pids];
}

async function normalizeTempHome(home: string): Promise<string> {
  assertAbsolutePath(home, 'home');

  const resolvedHome = await realpath(home)
    .then((value) => resolve(value))
    .catch(() => resolve(home));
  const tempRoot = resolve(await realpath(tmpdir()));
  const tempPrefix = `${tempRoot}${sep}`;

  invariant(
    resolvedHome === tempRoot || resolvedHome.startsWith(tempPrefix),
    'home must stay within the system temp directory',
  );

  return resolvedHome;
}

function extractSessionId(parsed: unknown): string {
  invariant(parsed !== undefined, 'CLI command must emit a JSON envelope');
  invariant(isRecord(parsed), 'CLI JSON envelope must be an object');
  invariant(parsed.ok === true, 'CLI JSON envelope must be a success result');

  const result = parsed.result;
  invariant(isRecord(result), 'CLI JSON envelope result must be an object');

  const sessionId = result.sessionId;
  assertString(
    sessionId,
    'CLI JSON envelope result.sessionId must be a string',
  );
  invariant(sessionId.length > 0, 'sessionId must be a non-empty string');

  return sessionId;
}

/** Synchronously run the agent-tty CLI for eval helpers. */
export function runEvalCli(
  args: string[],
  options: Partial<EvalCliOptions> = {},
): EvalCliResult {
  assertStringArray(args, 'args');
  invariant(
    options.args === undefined,
    'options.args is not supported; pass CLI arguments as the first parameter',
  );

  const cwd = resolve(options.cwd ?? process.cwd());
  assertNonEmptyString(cwd, 'cwd');
  assertStringRecord(options.env, 'env');

  if (options.home !== undefined) {
    assertAbsolutePath(options.home, 'home');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  invariant(
    Number.isInteger(timeoutMs) && timeoutMs >= 0,
    'timeoutMs must be a non-negative integer',
  );

  const finalArgs = withJsonFlag(args, options.json ?? true);
  const command = [
    process.execPath,
    '--import',
    'tsx',
    CLI_ENTRYPOINT,
    ...finalArgs,
  ];
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, command.slice(1), {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
      ...(options.home === undefined ? {} : { AGENT_TTY_HOME: options.home }),
    },
    timeout: timeoutMs,
  });
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  let parsed: unknown;
  if (hasCliFlagBeforeSeparator(finalArgs, CLI_JSON_FLAG)) {
    const trimmedStdout = result.stdout.trim();
    if (trimmedStdout.length > 0) {
      try {
        parsed = JSON.parse(trimmedStdout);
      } catch {
        parsed = undefined;
      }
    }
  }

  const candidateResult = {
    command,
    cwd,
    exitCode: result.status,
    signal: result.signal,
    ok: result.status === 0,
    durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(parsed === undefined ? {} : { parsed }),
  };
  const validatedResult = EvalCliResultSchema.safeParse(candidateResult);

  if (!validatedResult.success) {
    invariant(
      false,
      `runEvalCli result must satisfy EvalCliResultSchema: ${validatedResult.error.message}`,
    );
  }

  return validatedResult.data;
}

/** Create an isolated temp home directory for eval runs. */
export async function createIsolatedEvalHome(): Promise<string> {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), EVAL_HOME_PREFIX)),
  ).then((value) => resolve(value));

  assertAbsolutePath(home, 'home');
  return home;
}

/** Materialize a resolved workspace plan inside an isolated eval home. */
export async function materializeEvalWorkspace(
  input: PreparedWorkspaceInput,
): Promise<void> {
  assertAbsolutePath(input.homeDir, 'workspace homeDir');
  assertAbsolutePath(input.defaultCwd, 'workspace defaultCwd');
  assertStringRecord(input.effectiveEnv, 'workspace effectiveEnv');
  assertNonEmptyString(input.plan.presetId, 'workspace plan.presetId');
  invariant(
    Number.isInteger(input.plan.bootstrapCount) &&
      input.plan.bootstrapCount >= 0,
    'workspace plan.bootstrapCount must be a non-negative integer',
  );
  invariant(
    input.plan.bootstrapCount === input.plan.bootstrap.length,
    'workspace plan.bootstrapCount must match bootstrap length',
  );

  await assertExistingDirectory(input.homeDir, 'workspace homeDir');

  if (input.plan.templateDir !== undefined) {
    await assertExistingDirectory(
      input.plan.templateDir,
      'workspace plan.templateDir',
    );
    await copyDirectoryContents(input.plan.templateDir, input.homeDir);
  }

  if (input.plan.cwd !== undefined) {
    assertAbsolutePath(input.plan.cwd, 'workspace plan.cwd');
  }

  const workspaceCwd = resolve(input.plan.cwd ?? input.defaultCwd);
  await assertExistingDirectory(workspaceCwd, 'workspace bootstrap cwd');

  for (const [index, step] of input.plan.bootstrap.entries()) {
    assertNonEmptyString(
      step.command,
      `workspace bootstrap[${String(index)}].command`,
    );
    assertStringArray(step.args, `workspace bootstrap[${String(index)}].args`);

    const commandString = formatCommand(step.command, step.args);
    const result = spawnSync(step.command, [...step.args], {
      cwd: workspaceCwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...input.effectiveEnv,
        AGENT_TTY_HOME: input.homeDir,
      },
    });

    if (result.error !== undefined) {
      throw new Error(
        `Workspace preset "${input.plan.presetId}" bootstrap command failed to start: ${commandString}`,
        { cause: result.error },
      );
    }

    if (result.status !== 0) {
      throw new Error(
        `Workspace preset "${input.plan.presetId}" bootstrap command failed: ${commandString} (exitCode=${String(result.status)}, signal=${String(result.signal)})`,
      );
    }
  }
}

/** Best-effort cleanup for an isolated eval home and any lingering session processes. */
export async function cleanupEvalHome(home: string): Promise<void> {
  const normalizedHome = await normalizeTempHome(home);
  const sessionsRoot = resolve(normalizedHome, 'sessions');
  const sessionEntries = await readdir(sessionsRoot, {
    withFileTypes: true,
  }).catch(() => []);

  for (const entry of sessionEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const sessionDirectory = sessionDir(normalizedHome, entry.name);
      const sessionManifestPath = manifestPath(sessionDirectory);
      const rawManifest: unknown = JSON.parse(
        await readFile(sessionManifestPath, 'utf8'),
      );

      for (const pid of collectManifestPids(rawManifest)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Best-effort cleanup; ignore already-exited processes and permission errors.
        }
      }
    } catch {
      // Best-effort cleanup; ignore unreadable or malformed manifests.
    }
  }

  await rm(normalizedHome, { recursive: true, force: true });
}

/** Create and start an isolated eval session. */
export function createEvalSession(
  home: string,
  command: string[] = fixtureCommand('hello-prompt'),
): { sessionId: string } {
  assertAbsolutePath(home, 'home');
  assertStringArray(command, 'command');
  invariant(command.length > 0, 'command must include at least one segment');

  const result = runEvalCli(['--home', home, 'create', '--', ...command], {
    json: true,
  });

  invariant(result.ok, 'create session CLI command must exit successfully');

  return {
    sessionId: extractSessionId(result.parsed),
  };
}

/** Destroy an eval session by session ID. */
export function destroyEvalSession(home: string, sessionId: string): void {
  assertAbsolutePath(home, 'home');
  assertNonEmptyString(sessionId, 'sessionId');

  const result = runEvalCli(['--home', home, 'destroy', sessionId], {
    json: true,
  });

  invariant(result.ok, 'destroy session CLI command must exit successfully');
}

/** Read and validate all recorded event-log entries for an eval session. */
export function readEvalEvents(
  home: string,
  sessionId: string,
): EvalEventRecord[] {
  assertAbsolutePath(home, 'home');
  assertNonEmptyString(sessionId, 'sessionId');

  const eventsPath = eventLogPath(sessionDir(home, sessionId));
  if (!existsSync(eventsPath)) {
    return [];
  }

  const content = readFileSync(eventsPath, 'utf8');
  if (content.trim().length === 0) {
    return [];
  }

  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let rawRecord: unknown;

      try {
        rawRecord = JSON.parse(line);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to parse event log line ${String(index + 1)}: ${message}`,
          { cause: error },
        );
      }

      const parsedRecord = EventRecordSchema.safeParse(rawRecord);
      if (!parsedRecord.success) {
        invariant(
          false,
          `Invalid event record at line ${String(index + 1)}: ${parsedRecord.error.message}`,
        );
      }
      return parsedRecord.data;
    });
}

/** Build a fixture application command for eval sessions. */
export function fixtureCommand(appName: string): string[] {
  assertNonEmptyString(appName, 'appName');
  invariant(
    SAFE_FIXTURE_APP_NAME_PATTERN.test(appName),
    'appName must contain only lowercase letters, digits, and hyphens',
  );

  return [
    process.execPath,
    '--import',
    'tsx',
    `test/fixtures/apps/${appName}/main.ts`,
  ];
}
