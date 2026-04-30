import { spawnSync } from 'node:child_process';

import { invariant } from '../../src/util/assert.js';
import type { z } from 'zod';
import { errorMessage } from './errorMessage.js';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export type CommandRunner = (args: readonly string[]) => CommandResult;

// `gh issue list` with `--limit 500` plus per-issue `comments`/`labels` JSON
// can produce hundreds of KiB of stdout. Node's default `spawnSync`
// `maxBuffer` is 1 MiB, which would surface as `ENOBUFS` and abort the
// batch before any triage runs. Cap explicitly at 16 MiB so the ceiling
// matches the plan's "no hard batch cap" intent.
const SPAWN_SYNC_MAX_BUFFER = 16 * 1024 * 1024;

export function runGh(args: readonly string[]): CommandResult {
  return runCommand('gh', args);
}

export function runCoder(args: readonly string[]): CommandResult {
  return runCommand('coder', args);
}

/**
 * Run `<command> <args>` and parse stdout as JSON validated by `schema`.
 * Used for both `gh` and `coder` subcommands; `commandLabel` is included
 * in error messages so failures attribute correctly.
 */
export function runJson<T>(
  commandLabel: string,
  args: readonly string[],
  schema: z.ZodType<T>,
  runner: CommandRunner,
): T {
  const result = runner(args);

  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit status ${result.status}`;
    throw new Error(`${commandLabel} ${args.join(' ')} failed: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${commandLabel} ${args.join(' ')} returned invalid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return schema.parse(parsed);
}

/**
 * Backwards-compatible thin wrapper around {@link runJson} for callers that
 * specifically execute `gh` and want the historical error-message label.
 */
export function runGhJson<T>(
  args: readonly string[],
  schema: z.ZodType<T>,
  runner: CommandRunner = runGh,
): T {
  return runJson('gh', args, schema, runner);
}

function runCommand(command: string, args: readonly string[]): CommandResult {
  invariant(
    Array.isArray(args) && args.every((arg) => typeof arg === 'string'),
    `${command} arguments must be strings`,
  );

  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });

  return {
    stdout: result.stdout,
    stderr:
      result.stderr.length > 0 ? result.stderr : (result.error?.message ?? ''),
    status: result.status === null ? 1 : result.status,
  };
}
