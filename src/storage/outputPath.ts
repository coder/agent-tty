import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';
import { canonicalHomePath } from './home.js';

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function createMissingFolders(
  directory: string,
  refuseRealPath: (realPath: string) => void,
): Promise<void> {
  const missing: string[] = [];
  let existing = directory;
  while (!(await pathExists(existing))) {
    const parent = dirname(existing);
    invariant(parent !== existing, 'the filesystem root must exist');
    missing.unshift(basename(existing));
    existing = parent;
  }
  if (missing.length === 0) {
    return;
  }

  let current = await realpath(existing);
  refuseRealPath(join(current, ...missing));
  for (const name of missing) {
    current = join(current, name);
    try {
      await mkdir(current);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
    if ((await realpath(current)) !== current) {
      throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
        message: `Output folder ${current} resolved to another place while it was being created.`,
        details: { outputPath: current },
      });
    }
  }
}

export interface ExplicitOutputPath {
  path: string;
  parentDev: bigint;
  parentIno: bigint;
}

export async function resolveExplicitOutputPath(
  outputPath: string,
  sessionsRoot: string,
): Promise<ExplicitOutputPath> {
  invariant(outputPath.length > 0, 'output path must be a non-empty string');
  invariant(isAbsolute(sessionsRoot), 'sessionsRoot must be an absolute path');

  const resolvedOutputPath = isAbsolute(outputPath)
    ? resolve(outputPath)
    : resolve(process.cwd(), outputPath);
  const realSessionsRoot = canonicalHomePath(sessionsRoot);
  const refuseInsideSessions = (realPath: string): void => {
    if (isInside(realSessionsRoot, realPath)) {
      throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
        message: `Output path ${realPath} is inside agent-tty session storage (${realSessionsRoot}). Choose a path outside it.`,
        details: { out: outputPath, outputPath: realPath },
      });
    }
  };

  await createMissingFolders(dirname(resolvedOutputPath), refuseInsideSessions);
  const realParentDirectory = await realpath(dirname(resolvedOutputPath));
  const parentStats = await lstat(realParentDirectory, { bigint: true });

  invariant(
    parentStats.isDirectory(),
    `output parent directory must be a directory: ${realParentDirectory}`,
  );

  await access(realParentDirectory, constants.W_OK | constants.X_OK);

  const realOutputPath = resolve(
    realParentDirectory,
    basename(resolvedOutputPath),
  );
  invariant(
    dirname(realOutputPath) === realParentDirectory,
    'output path must remain within the resolved parent directory',
  );

  refuseInsideSessions(realOutputPath);
  return {
    path: realOutputPath,
    parentDev: parentStats.dev,
    parentIno: parentStats.ino,
  };
}

export async function assertOutputParentUnchanged(
  output: ExplicitOutputPath,
): Promise<void> {
  const parentDirectory = dirname(output.path);
  let realParentDirectory: string;
  let parentStats: BigIntStats;
  try {
    realParentDirectory = await realpath(parentDirectory);
    parentStats = await lstat(parentDirectory, { bigint: true });
  } catch (error) {
    throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
      message: `Output folder ${parentDirectory} could not be checked again before the write. Nothing was written to ${output.path}.`,
      details: { outputPath: output.path },
      cause: error,
    });
  }
  if (
    realParentDirectory !== parentDirectory ||
    parentStats.dev !== output.parentDev ||
    parentStats.ino !== output.parentIno
  ) {
    throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
      message: `Output folder ${parentDirectory} was replaced while the command ran. Nothing was written to ${output.path}.`,
      details: { outputPath: output.path },
    });
  }
}

export async function copyFileReplacing(
  sourcePath: string,
  output: ExplicitOutputPath,
): Promise<void> {
  invariant(isAbsolute(sourcePath), 'sourcePath must be an absolute path');
  invariant(isAbsolute(output.path), 'outputPath must be an absolute path');

  const temporaryPath = `${output.path}.tmp-${randomUUID()}`;
  try {
    await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    await assertOutputParentUnchanged(output);
    await rename(temporaryPath, output.path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
