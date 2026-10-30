import { resolve } from 'node:path';

import { emitSuccess } from '../../output.js';
import {
  createHomeRegistry,
  normalizeHomePath,
} from '../../../storage/homeRegistry.js';

const COMMAND_NAME = 'home forget';

export interface HomeForgetResult {
  path: string;
  forgotten: boolean;
}

export interface HomeForgetCommandOptions {
  json: boolean;
  path: string;
}

export interface HomeForgetCommandDependencies {
  forget?: (path: string) => Promise<string | null>;
}

export async function runHomeForgetCommand(
  options: HomeForgetCommandOptions,
  dependencies: HomeForgetCommandDependencies = {},
): Promise<void> {
  // Pass the path as written: the store prefers the entry stored under it and
  // returns the path of the entry it removed.
  // forget never touches the Home directory on disk — registry-only.
  const normalizedPath = normalizeHomePath(options.path);
  const forget =
    dependencies.forget ??
    ((path: string) => createHomeRegistry().forget(path));
  const forgottenPath = await forget(resolve(options.path));
  const forgotten = forgottenPath !== null;
  const path = forgottenPath ?? normalizedPath;

  const result: HomeForgetResult = { path, forgotten };
  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: [
      forgotten ? `Forgot Home: ${path}` : `Home not in registry: ${path}`,
    ],
  });
}
