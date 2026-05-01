import { spawn, spawnSync } from 'node:child_process';

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
 * Async counterpart to {@link runCoder}.
 *
 * The synchronous variant blocks the entire Node event loop, which prevents
 * a second SIGINT/SIGTERM from being delivered until the child exits. The
 * AFK-triage signal handler relies on async `sandbox.close()` calls that
 * yield to the event loop precisely so a second signal can force-quit a
 * hung cleanup; calling `runCoder()` synchronously inside that handler
 * (e.g. for the in-flight workspace reap path) breaks that invariant. Use
 * this async variant in the signal-handler cleanup path.
 */
export function runCoderAsync(args: readonly string[]): Promise<CommandResult> {
  return runCommandAsync('coder', args);
}

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

/**
 * Async sibling of {@link runCommand} that uses the streaming `spawn` API
 * so the Node event loop remains responsive while the child runs. Used by
 * signal-handler cleanup paths so a second SIGINT/SIGTERM can force-exit
 * even if the child hangs.
 */
export function runCommandAsync(
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  invariant(
    Array.isArray(args) && args.every((arg) => typeof arg === 'string'),
    `${command} arguments must be strings`,
  );

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > SPAWN_SYNC_MAX_BUFFER) {
        child.kill('SIGKILL');
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > SPAWN_SYNC_MAX_BUFFER) {
        child.kill('SIGKILL');
      }
    });

    child.on('error', (error) => {
      spawnError = error;
    });

    child.on('close', (code) => {
      const finalStderr =
        stderr.length > 0 ? stderr : (spawnError?.message ?? '');
      resolve({
        stdout,
        stderr: finalStderr,
        // null means the process was killed via signal; treat the same as
        // spawnSync's null === 1 fallback so callers see a non-zero status.
        status: code === null ? 1 : code,
      });
    });
  });
}
