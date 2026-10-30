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
  forget?: (path: string) => Promise<boolean>;
}

export async function runHomeForgetCommand(
  options: HomeForgetCommandOptions,
  dependencies: HomeForgetCommandDependencies = {},
): Promise<void> {
  // Display the normalized path, but pass the path as written, which the store
  // also matches against the stored entries.
  // forget never touches the Home directory on disk — registry-only.
  const normalizedPath = normalizeHomePath(options.path);
  const forget =
    dependencies.forget ??
    ((path: string) => createHomeRegistry().forget(path));
  const forgotten = await forget(resolve(options.path));

  const result: HomeForgetResult = { path: normalizedPath, forgotten };
  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: [
      forgotten
        ? `Forgot Home: ${normalizedPath}`
        : `Home not in registry: ${normalizedPath}`,
    ],
  });
}
