import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEvents, runCli } from '../helpers.js';

export {
  cleanupHome,
  createSession,
  destroySession,
  inspectSession,
  readEvents,
  runCli,
  sleep,
  type EventRecord,
  type SessionRecord,
  type SuccessEnvelope,
  type WaitResult,
} from '../helpers.js';

export const DEFAULT_CLI_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_MS = 500;
export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

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
  const { stdout } = runCli(withJsonFlag(args), env, DEFAULT_CLI_TIMEOUT_MS);

  assert(stdout.length > 0, 'expected JSON output from CLI command');

  return JSON.parse(stdout) as TResult;
}

export function normalizeTerminalOutput(output: string): string {
  return output.replaceAll('\r\n', '\n');
}

export async function createIsolatedHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-terminal-e2e-home-'));
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
  appName:
    | 'hello-prompt'
    | 'resize-demo'
    | 'color-grid'
    | 'alt-screen-demo'
    | 'crash-demo',
): string[] {
  return ['node', '--import', 'tsx', `test/fixtures/apps/${appName}/main.ts`];
}
