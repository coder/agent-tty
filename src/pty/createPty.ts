import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
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
    env: {
      ...process.env,
      ...env,
      TERM: term,
    },
  });
}
