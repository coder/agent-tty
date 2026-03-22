import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import process from 'node:process';

import { invariant } from '../util/assert.js';

const DEFAULT_HOME_DIRECTORY_NAME = '.agent-terminal';

function validateConfiguredHome(
  configuredHome: string,
  source: string,
): string {
  invariant(configuredHome.length > 0, `${source} must not be empty`);
  invariant(isAbsolute(configuredHome), `${source} must be an absolute path`);

  return normalize(configuredHome);
}

export function resolveHome(
  configuredHome = process.env.AGENT_TERMINAL_HOME,
): string {
  if (configuredHome !== undefined) {
    return validateConfiguredHome(configuredHome, 'AGENT_TERMINAL_HOME');
  }

  const resolvedHome = normalize(join(homedir(), DEFAULT_HOME_DIRECTORY_NAME));

  invariant(
    isAbsolute(resolvedHome),
    'resolved agent-terminal home must be absolute',
  );

  return resolvedHome;
}

export async function ensureHome(
  configuredHome = process.env.AGENT_TERMINAL_HOME,
): Promise<string> {
  const home = resolveHome(configuredHome);

  await mkdir(home, { recursive: true });

  return home;
}
