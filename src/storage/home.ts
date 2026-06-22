import { realpathSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import process from 'node:process';

import { invariant } from '../util/assert.js';

const DEFAULT_HOME_DIRECTORY_NAME = '.agent-tty';

function validateConfiguredHome(
  configuredHome: string,
  source: string,
): string {
  invariant(configuredHome.length > 0, `${source} must not be empty`);
  invariant(isAbsolute(configuredHome), `${source} must be an absolute path`);

  const normalized = normalize(configuredHome);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

export function resolveHome(
  configuredHome = process.env.AGENT_TTY_HOME,
): string {
  if (configuredHome !== undefined) {
    return validateConfiguredHome(configuredHome, 'AGENT_TTY_HOME');
  }

  const normalized = normalize(join(homedir(), DEFAULT_HOME_DIRECTORY_NAME));

  invariant(isAbsolute(normalized), 'resolved agent-tty home must be absolute');

  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
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
