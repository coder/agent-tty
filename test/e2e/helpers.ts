import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export const DEFAULT_CLI_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_MS = 500;
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SuccessEnvelope<TResult> {
  ok: true;
  command: string;
  timestamp: string;
  result: TResult;
}

export interface EventRecord {
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface SessionRecord {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  command: string[];
  cwd: string;
  cols: number;
  rows: number;
  hostPid: number | null;
  childPid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
}

export function runCli(
  args: string[],
  env: Record<string, string>,
  timeout = DEFAULT_CLI_TIMEOUT_MS,
): CommandResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', './src/cli/main.ts', ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout,
    },
  );

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 1,
  };
}

function withJsonFlag(args: string[]): string[] {
  const commandSeparatorIndex = args.indexOf('--');

  if (commandSeparatorIndex === -1) {
    return [...args, '--json'];
  }

  return [
    ...args.slice(0, commandSeparatorIndex),
    '--json',
    ...args.slice(commandSeparatorIndex),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed JSON helper keeps call sites concise in test code.
export function runCliJson<TResult>(
  args: string[],
  env: Record<string, string>,
): TResult {
  const { stdout } = runCli(withJsonFlag(args), env);

  assert(stdout.length > 0, 'expected JSON output from CLI command');

  return JSON.parse(stdout) as TResult;
}

export function normalizeTerminalOutput(output: string): string {
  return output.replaceAll('\r\n', '\n');
}

export async function createIsolatedHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-terminal-e2e-home-'));
}

export async function cleanupHome(home: string): Promise<void> {
  if (home.length === 0) {
    return;
  }

  try {
    const sessionsDir = join(home, 'sessions');
    const entries = await readdir(sessionsDir).catch((): string[] => []);

    for (const entry of entries) {
      const manifestFile = join(sessionsDir, entry, 'session.json');

      try {
        const manifest = JSON.parse(
          await readFile(manifestFile, 'utf8'),
        ) as Record<string, unknown>;

        for (const pidKey of ['childPid', 'hostPid'] as const) {
          const pid = manifest[pidKey];
          if (typeof pid === 'number' && pid > 0) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // best-effort cleanup, ignore errors
            }
          }
        }
      } catch {
        // best-effort cleanup, ignore errors
      }
    }
  } catch {
    // best-effort cleanup, ignore errors
  }

  await rm(home, { recursive: true, force: true });
}

export async function readEvents(
  home: string,
  sessionId: string,
): Promise<EventRecord[]> {
  const eventsPath = join(home, 'sessions', sessionId, 'events.jsonl');
  const content = await readFile(eventsPath, 'utf8');

  if (content.trim().length === 0) {
    return [];
  }

  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

export async function readOutput(
  home: string,
  sessionId: string,
): Promise<string> {
  const events = await readEvents(home, sessionId);

  return events
    .filter((event) => event.type === 'output')
    .map((event) => {
      const data = event.payload.data;
      return typeof data === 'string' ? data : '';
    })
    .join('');
}

export function fixtureCommand(
  appName: 'hello-prompt' | 'resize-demo',
): string[] {
  return ['node', '--import', 'tsx', `test/fixtures/apps/${appName}/main.ts`];
}
