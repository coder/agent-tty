import { link, readFile, rm } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';
import { hasErrorCode } from '../util/hasErrorCode.js';
import { artifactPath } from './artifactPaths.js';

export interface PublishArtifactFileOptions {
  sessionDir: string;
  temporaryPath: string;
  filename: string;
}

export interface PublishedArtifactFile {
  filename: string;
  path: string;
  /** False when the call reused an existing file with identical bytes. */
  created: boolean;
}

function variantFilename(filename: string, variant: number): string {
  if (variant === 1) {
    return filename;
  }
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  return `${stem}-${String(variant)}${extension}`;
}

/**
 * Moves a fully written temporary file into the session artifacts directory
 * without replacing an existing file, because earlier manifest entries can
 * point at it. Identical bytes reuse the existing file. Different bytes take
 * the first free `<stem>-<n><ext>` name. The temporary file is always removed.
 */
export async function publishArtifactFile(
  options: PublishArtifactFileOptions,
): Promise<PublishedArtifactFile> {
  invariant(
    isAbsolute(options.temporaryPath),
    'temporaryPath must be an absolute path',
  );
  const preferredPath = artifactPath(options.sessionDir, options.filename);
  let contents: Buffer | undefined;

  try {
    for (let variant = 1; ; variant += 1) {
      const filename = variantFilename(options.filename, variant);
      const path = artifactPath(options.sessionDir, filename);
      try {
        await link(options.temporaryPath, path);
        return { filename, path, created: true };
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          throw error;
        }
      }

      contents ??= await readFile(options.temporaryPath);
      if (contents.equals(await readFile(path))) {
        return { filename, path, created: false };
      }
    }
  } catch (error) {
    throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
      message: `Failed to store artifact at ${preferredPath}.`,
      details: { path: preferredPath },
      cause: error,
    });
  } finally {
    await rm(options.temporaryPath, { force: true }).catch(() => undefined);
  }
}
