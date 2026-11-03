import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import type { CliError } from '../cli/errors.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { socketRootDirectory } from '../storage/sessionPaths.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

// Other users can create entries in /tmp. Only a directory of this uid with
// no group or other bits, not a symlink, keeps their sockets and folders out
// of the root.
function isPrivateRoot(stats: Stats, uid: number): boolean {
  return stats.isDirectory() && stats.uid === uid && (stats.mode & 0o077) === 0;
}

function unsafeRootError(root: string, stats: Stats, uid: number): CliError {
  const kind = stats.isSymbolicLink()
    ? 'a symlink'
    : stats.isDirectory()
      ? 'a directory'
      : 'a file';
  const mode = (stats.mode & 0o777).toString(8);
  return makeCliError(ERROR_CODES.STORAGE_WRITE_ERROR, {
    message: `The socket root ${root} is ${kind} of uid ${String(stats.uid)} with mode ${mode}. It must be a directory of uid ${String(uid)} with mode 700: remove it or fix it.`,
    details: { path: root, ownerUid: stats.uid, mode },
  });
}

// Another user can still create the root first and so block this uid.
export async function ensureSocketRoot(
  root: string = socketRootDirectory(),
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return;
  }
  try {
    // The mkdir mode keeps every other user out from the start. umask can
    // also take owner bits from it, and the chmod gives them back.
    await mkdir(root, { mode: 0o700 });
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
  if (!isPrivateRoot(stats, uid)) {
    throw unsafeRootError(root, stats, uid);
  }
  // A create in another process that umask took owner bits from shows mode
  // 000 until its chmod. Only this uid or root can replace the entry in the
  // sticky /tmp, so this chmod reaches the directory that lstat showed.
  if ((stats.mode & 0o700) !== 0o700) {
    await chmod(root, 0o700);
  }
}

// false when the root is missing, so that no socket can be in it. Another
// user could create a missing root before a later connect, so a caller
// connects only after this returns true.
export async function socketRootExists(
  root: string = socketRootDirectory(),
): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return true;
  }
  let stats: Stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
  if (!isPrivateRoot(stats, uid)) {
    throw unsafeRootError(root, stats, uid);
  }
  return true;
}

// A socket of this uid under /tmp/agent-tty, where a host of an older version
// listens. No other user may be able to rename or replace a folder on its
// path before the connect: the Home's folder is this uid's and not writable
// by others, and the root is this uid's or root's, either not writable by
// others or sticky. Remove this after one minor release.
export async function isOwnLegacySocket(socketFile: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return false;
  }
  const homeDirectory = dirname(socketFile);
  try {
    const [root, directory, socket] = await Promise.all([
      lstat(dirname(homeDirectory)),
      lstat(homeDirectory),
      lstat(socketFile),
    ]);
    return (
      root.isDirectory() &&
      (root.uid === uid || root.uid === 0) &&
      ((root.mode & 0o022) === 0 || (root.mode & 0o1000) !== 0) &&
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
