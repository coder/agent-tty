import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { socketRootDirectory } from '../storage/sessionPaths.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

// Other users can create entries in /tmp, so the root must be a directory,
// not a symlink, of this uid, with no group or other bits. Another user can
// still create the root first and so block this uid.
export async function ensureSocketRoot(
  root: string = socketRootDirectory(),
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return;
  }
  try {
    await mkdir(root);
    // umask applies to a mkdir mode, not to chmod.
    await chmod(root, 0o700);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
        message: `Failed to create the socket root ${root}.`,
        details: { path: root },
        cause: error,
      });
    }
  }
  const stats = await lstat(root);
  if (stats.isDirectory() && stats.uid === uid && (stats.mode & 0o077) === 0) {
    return;
  }
  const kind = stats.isSymbolicLink()
    ? 'a symlink'
    : stats.isDirectory()
      ? 'a directory'
      : 'a file';
  const mode = (stats.mode & 0o777).toString(8);
  throw makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
    message: `The socket root ${root} is ${kind} of uid ${String(stats.uid)} with mode ${mode}. It must be a directory of uid ${String(uid)} with mode 700: remove it or fix it.`,
    details: { path: root, ownerUid: stats.uid, mode },
  });
}

// A socket that lstat shows as ours, in a folder that no other user can
// write, so that nobody can swap it before the connect.
export async function isOwnSocket(socketFile: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return false;
  }
  try {
    const [directory, socket] = await Promise.all([
      lstat(dirname(socketFile)),
      lstat(socketFile),
    ]);
    return (
      directory.isDirectory() &&
      directory.uid === uid &&
      (directory.mode & 0o022) === 0 &&
      socket.isSocket() &&
      socket.uid === uid
    );
  } catch {
    return false;
  }
}
