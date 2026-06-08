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
  // Normalize for display and matching; the store normalizes again (idempotent).
  // forget never touches the Home directory on disk — registry-only.
  const normalizedPath = normalizeHomePath(options.path);
  const forget =
    dependencies.forget ??
    ((path: string) => createHomeRegistry().forget(path));
  const forgotten = await forget(normalizedPath);

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
