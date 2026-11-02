import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';

import {
  DESTROY_RERUN_ENV_KEY,
  HOST_RENDERER_ENV_KEY,
} from '../config/defaults.js';
import { invariant } from '../util/assert.js';

export interface PtyOptions {
  command: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  term: string;
  sessionId?: string;
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
 *
 * `COLORTERM=truecolor` tells programs that the renderer draws 24-bit color.
 * Neovim reads it before it queries the terminal, and any other non-empty
 * value, such as one inherited from the launching terminal, skips that query.
 */
const SPAWN_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  PROMPT_EOL_MARK: '',
  COLORTERM: 'truecolor',
};

/**
 * Resolves the environment handed to the spawned PTY shell.
 *
 * Precedence, lowest to highest: the inherited process environment (minus
 * host-only internals), then `SPAWN_ENV_DEFAULTS`, then the generated session
 * metadata, then the caller-supplied `env` (so a `--env` value always wins —
 * even an explicit empty one), then `TERM`. The session metadata is
 * `AGENT_TTY_ACTIVE=true` plus `AGENT_TTY_SESSION_ID` when
 * `sessionId` is given; without a `sessionId` both are removed instead, so a
 * session-less PTY never claims an inherited outer session. The defaults sit
 * after the inherited environment so they also override inherited values: a
 * nested session reports its own id rather than the outer session's, and
 * captures stay deterministic regardless of the launching shell. Only `env`
 * (the user-explicit set) opts out of a default, so an inherited value never
 * counts as opting out. The destroy re-run marker never reaches the program,
 * not even through `env`.
 */
export function resolvePtyEnv(
  env: Record<string, string>,
  term: string,
  baseEnv: Record<string, string | undefined> = process.env,
  sessionId?: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key === HOST_RENDERER_ENV_KEY || key === DESTROY_RERUN_ENV_KEY) {
      continue;
    }
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  Object.assign(resolved, SPAWN_ENV_DEFAULTS);

  invariant(
    sessionId === undefined || sessionId.length > 0,
    'resolvePtyEnv: sessionId must be non-empty when provided',
  );
  if (sessionId === undefined) {
    // A PTY without a session (the doctor spawn probe) must not claim one, so
    // drop any session variables inherited from an outer session.
    delete resolved.AGENT_TTY_ACTIVE;
    delete resolved.AGENT_TTY_SESSION_ID;
  } else {
    resolved.AGENT_TTY_ACTIVE = 'true';
    resolved.AGENT_TTY_SESSION_ID = sessionId;
  }

  for (const [key, value] of Object.entries(env)) {
    if (key !== DESTROY_RERUN_ENV_KEY) {
      resolved[key] = value;
    }
  }
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
    env: resolvePtyEnv(env, term, process.env, options.sessionId),
  });
}
