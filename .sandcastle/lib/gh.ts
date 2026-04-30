import { spawnSync } from 'node:child_process';

import { invariant } from '../../src/util/assert.js';
import type { z } from 'zod';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export type CommandRunner = (args: readonly string[]) => CommandResult;

export function runGh(args: readonly string[]): CommandResult {
  return runCommand('gh', args);
}

export function runCoder(args: readonly string[]): CommandResult {
  return runCommand('coder', args);
}

export function runGhJson<T>(
  args: readonly string[],
  schema: z.ZodType<T>,
  runner: CommandRunner = runGh,
): T {
  const result = runner(args);

  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit status ${result.status}`;
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `gh ${args.join(' ')} returned invalid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return schema.parse(parsed);
}

function runCommand(command: string, args: readonly string[]): CommandResult {
  invariant(
    Array.isArray(args) && args.every((arg) => typeof arg === 'string'),
    `${command} arguments must be strings`,
  );

  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
  });

  return {
    stdout: result.stdout,
    stderr:
      result.stderr.length > 0 ? result.stderr : (result.error?.message ?? ''),
    status: result.status === null ? 1 : result.status,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
