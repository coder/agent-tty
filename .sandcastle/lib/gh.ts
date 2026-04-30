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
 * Spawn `command` with `args` synchronously and normalize the result into a
 * CommandResult. Exported so `runJson` and the targeted ENOENT regression
 * test can both exercise the same normalization path.
 */
export function runCommand(
  command: string,
  args: readonly string[],
): CommandResult {
  invariant(
    Array.isArray(args) && args.every((arg) => typeof arg === 'string'),
    `${command} arguments must be strings`,
  );

  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });

  // When the binary is not on PATH (ENOENT) or the spawn itself otherwise
  // fails before the child runs, spawnSync returns `undefined` for both
  // `stdout` and `stderr`. Default both to '' so:
  //   - `result.stderr.length` does not throw `Cannot read properties of
  //     undefined`,
  //   - the CommandResult contract (`stdout: string`) is honored,
  //   - `runJson` gets a parseable empty payload that funnels into the
  //     'invalid JSON' diagnostic with the spawn-error message attached
  //     via the `result.error?.message` fallback below.
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  return {
    stdout,
    stderr: stderr.length > 0 ? stderr : (result.error?.message ?? ''),
    status: result.status === null ? 1 : result.status,
  };
}
