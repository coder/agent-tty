import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
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

  const realSessionsRoot = await realpath(sessionsRoot).catch(
    (error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) {
        return null;
      }
      throw error;
    },
  );
  if (realSessionsRoot !== null && isInside(realSessionsRoot, realOutputPath)) {
    throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
      message: `Output path ${realOutputPath} is inside agent-tty session storage (${realSessionsRoot}). Choose a path outside it.`,
      details: { out: outputPath, outputPath: realOutputPath },
    });
  }
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
  const realParentDirectory = await realpath(parentDirectory);
  const parentStats = await lstat(parentDirectory, { bigint: true });
  if (
    realParentDirectory !== parentDirectory ||
    parentStats.dev !== output.parentDev ||
    parentStats.ino !== output.parentIno
  ) {
    throw makeCliError(ERROR_CODES.EXPORT_ERROR, {
      message: `Output folder ${parentDirectory} was replaced during the export. Nothing was written to ${output.path}.`,
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
