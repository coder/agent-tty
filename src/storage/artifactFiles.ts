import { constants } from 'node:fs';
import { copyFile, link, open, readFile, rm } from 'node:fs/promises';
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

// Codes `link` returns on filesystems without hard links (vfat, exFAT, SMB
// without Unix extensions, some FUSE mounts).
const NO_HARD_LINK_ERROR_CODES = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];
const MAX_VANISHED_FILE_RETRIES = 3;

/** Returns false when `path` already exists. */
async function createWithoutReplacing(
  temporaryPath: string,
  path: string,
): Promise<boolean> {
  try {
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!NO_HARD_LINK_ERROR_CODES.some((code) => hasErrorCode(error, code))) {
        throw error;
      }
      // Still refuses to replace a file, but a reader can see a partly
      // copied file until the copy finishes.
      await copyFile(temporaryPath, path, constants.COPYFILE_EXCL);
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
}

// O_NOFOLLOW fails with ELOOP only when the final path component is a
// symlink, so a symlink at the artifact name is never reused. It does not
// check the parent folders, and a hard link still counts as a regular file.
// O_NONBLOCK keeps a FIFO at the name from blocking the open until a writer
// appears. It has no effect on reads from a regular file.
async function readRegularFile(path: string): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
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
 * point at it. Identical bytes reuse the existing file. Different bytes try
 * `<stem>-2<ext>`, `<stem>-3<ext>` and so on, reuse the first one with
 * identical bytes, or create the first free one. The temporary file is always
 * removed.
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
    let variant = 1;
    let vanishedFileRetries = 0;
    for (;;) {
      const filename = variantFilename(options.filename, variant);
      const path = artifactPath(options.sessionDir, filename);
      if (await createWithoutReplacing(options.temporaryPath, path)) {
        return { filename, path, created: true };
      }

      contents ??= await readFile(options.temporaryPath);
      let existing: Buffer;
      try {
        existing = await readRegularFile(path);
      } catch (error) {
        // Another capture's rollback can remove the file after our EEXIST.
        if (
          hasErrorCode(error, 'ENOENT') &&
          vanishedFileRetries < MAX_VANISHED_FILE_RETRIES
        ) {
          vanishedFileRetries += 1;
          continue;
        }
        throw error;
      }
      if (contents.equals(existing)) {
        return { filename, path, created: false };
      }
      variant += 1;
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
