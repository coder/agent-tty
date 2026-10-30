import { realpathSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import process from 'node:process';

import { invariant } from '../util/assert.js';

const DEFAULT_HOME_DIRECTORY_NAME = '.agent-tty';

/**
 * The real path of the deepest existing ancestor of `path`, joined with the
 * parts below it that do not exist yet. This equals `realpathSync(path)` once
 * those parts exist, so a Home resolves to one path before and after `create`
 * makes it: the CLI and the host must hash the same path for the socket.
 */
export function canonicalHomePath(
  path: string,
  realpath: (path: string) => string = realpathSync,
): string {
  invariant(isAbsolute(path), 'home path must be absolute');
  try {
    return realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path
      ? path
      : join(canonicalHomePath(parent, realpath), basename(path));
  }
}

function validateConfiguredHome(
  configuredHome: string,
  source: string,
): string {
  invariant(configuredHome.length > 0, `${source} must not be empty`);
  invariant(isAbsolute(configuredHome), `${source} must be an absolute path`);

  return canonicalHomePath(normalize(configuredHome));
}

export function resolveHome(
  configuredHome = process.env.AGENT_TTY_HOME,
): string {
  if (configuredHome !== undefined) {
    return validateConfiguredHome(configuredHome, 'AGENT_TTY_HOME');
  }

  const normalized = normalize(join(homedir(), DEFAULT_HOME_DIRECTORY_NAME));

  invariant(isAbsolute(normalized), 'resolved agent-tty home must be absolute');

  return canonicalHomePath(normalized);
}

export async function ensureHome(
  configuredHome = process.env.AGENT_TTY_HOME,
): Promise<string> {
  const home = resolveHome(configuredHome);

  const created = await mkdir(home, { recursive: true });
  if (created !== undefined) {
    // Owner-only: the Home lists session directories and the Home Registry.
    // chmod (not mkdir mode) guarantees 0o700 regardless of umask. Only when we
    // created it — never re-mode a Home the user set up themselves.
    await chmod(home, 0o700);
  }

  return home;
}
