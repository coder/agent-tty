import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';

import { HOST_RENDERER_ENV_KEY } from '../config/defaults.js';
import { invariant } from '../util/assert.js';

export interface PtyOptions {
  command: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  term: string;
}

const EXECUTABLE_PERMISSION_MASK = 0o111;
const require = createRequire(import.meta.url);
const NODE_PTY_PACKAGE_DIRECTORY = dirname(
  require.resolve('node-pty/package.json'),
);

function resolveDarwinSpawnHelperPath(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  const prebuildDirectory =
    process.arch === 'arm64'
      ? 'darwin-arm64'
      : process.arch === 'x64'
        ? 'darwin-x64'
        : null;
  if (prebuildDirectory === null) {
    return null;
  }

  return join(
    NODE_PTY_PACKAGE_DIRECTORY,
    'prebuilds',
    prebuildDirectory,
    'spawn-helper',
  );
}

function ensureDarwinSpawnHelperExecutable(): void {
  const helperPath = resolveDarwinSpawnHelperPath();
  if (helperPath === null) {
    return;
  }

  try {
    const helperStats = statSync(helperPath);
    if (!helperStats.isFile()) {
      return;
    }

    if ((helperStats.mode & EXECUTABLE_PERMISSION_MASK) !== 0) {
      return;
    }

    chmodSync(helperPath, helperStats.mode | EXECUTABLE_PERMISSION_MASK);
  } catch {
    // Best-effort repair; node-pty will still surface a clear spawn failure.
  }
}

/**
 * The zsh-only `PROMPT_EOL_MARK` parameter controls the inverse-video glyph zsh
 * prints when a line of output has no trailing newline (its default expands to a
 * bold standout `%`). agent-tty injects a hidden completion-marker postamble
 * after each `run` and strips that postamble's echo from the output stream; the
 * strip leaves the rendered cursor mid-line, so zsh's unconditional end-of-line
 * mark surfaces as a stray `%` in snapshots, screenshots, and recordings.
 * Defaulting the parameter to empty suppresses the glyph. It is inert in shells
 * that do not implement it (bash, etc.), so setting it unconditionally is safe.
 */
const PROMPT_EOL_MARK_ENV_KEY = 'PROMPT_EOL_MARK';

/**
 * Resolves the environment handed to the spawned PTY shell.
 *
 * Precedence, lowest to highest: the inherited process environment (minus
 * host-only internals), then the `PROMPT_EOL_MARK=''` default, then the caller-supplied `env` (so a `--env`
 * value always wins — even an explicit empty one), then `TERM`. The default sits
 * after the inherited environment so it also overrides any inherited
 * `PROMPT_EOL_MARK`, keeping captures deterministic regardless of the launching
 * shell. The presence check is against `env` (the user-explicit set) rather than
 * the merged result, so an inherited value never counts as opting out.
 */
export function resolvePtyEnv(
  env: Record<string, string>,
  term: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key === HOST_RENDERER_ENV_KEY) {
      continue;
    }
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  if (!Object.prototype.hasOwnProperty.call(env, PROMPT_EOL_MARK_ENV_KEY)) {
    resolved[PROMPT_EOL_MARK_ENV_KEY] = '';
  }

  Object.assign(resolved, env);
  resolved.TERM = term;
  return resolved;
}

export function createPty(options: PtyOptions): IPty {
  const { command, cwd, cols, rows, env, term } = options;

  invariant(command.length > 0, 'PTY command must not be empty');
  invariant(
    Number.isInteger(cols) && cols > 0,
    'PTY cols must be a positive integer',
  );
  invariant(
    Number.isInteger(rows) && rows > 0,
    'PTY rows must be a positive integer',
  );
  invariant(term.length > 0, 'PTY term must not be empty');

  const file = command[0];
  invariant(file !== undefined, 'PTY command must have an executable');

  for (const [entryKey, entryValue] of Object.entries(env)) {
    invariant(entryKey.length > 0, 'PTY env keys must not be empty');
    invariant(typeof entryValue === 'string', 'PTY env values must be strings');
  }

  ensureDarwinSpawnHelperExecutable();

  return spawn(file, command.slice(1), {
    cwd,
    cols,
    rows,
    env: resolvePtyEnv(env, term),
  });
}
