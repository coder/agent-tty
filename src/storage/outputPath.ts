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
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';

import { invariant } from '../util/assert.js';

export async function resolveExplicitOutputPath(
  outputPath: string,
): Promise<string> {
  invariant(outputPath.length > 0, 'output path must be a non-empty string');

  const resolvedOutputPath = isAbsolute(outputPath)
    ? resolve(outputPath)
    : resolve(process.cwd(), outputPath);
  const realParentDirectory = await realpath(dirname(resolvedOutputPath));
  const parentStats = await lstat(realParentDirectory);

  invariant(
    parentStats.isDirectory(),
    `output parent directory must be a directory: ${realParentDirectory}`,
  );

  await access(realParentDirectory, constants.W_OK);

  const realOutputPath = resolve(
    realParentDirectory,
    basename(resolvedOutputPath),
  );
  invariant(
    dirname(realOutputPath) === realParentDirectory,
    'output path must remain within the resolved parent directory',
  );
  return realOutputPath;
}

export async function copyFileReplacing(
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  invariant(isAbsolute(sourcePath), 'sourcePath must be an absolute path');
  invariant(isAbsolute(outputPath), 'outputPath must be an absolute path');

  const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
  try {
    await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
