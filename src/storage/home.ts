import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import process from 'node:process';

import { invariant } from '../util/assert.js';

const DEFAULT_HOME_DIRECTORY_NAME = '.agent-terminal';

export function resolveHome(): string {
  const configuredHome = process.env.AGENT_TERMINAL_HOME;

  if (configuredHome !== undefined) {
    invariant(configuredHome.length > 0, 'AGENT_TERMINAL_HOME must not be empty');
    invariant(
      isAbsolute(configuredHome),
      'AGENT_TERMINAL_HOME must be an absolute path',
    );

    return normalize(configuredHome);
  }

  const resolvedHome = normalize(join(homedir(), DEFAULT_HOME_DIRECTORY_NAME));

  invariant(
    isAbsolute(resolvedHome),
    'resolved agent-terminal home must be absolute',
  );

  return resolvedHome;
}

export async function ensureHome(): Promise<string> {
  const home = resolveHome();

  await mkdir(home, { recursive: true });

  return home;
}
