import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Returns `true` when `candidatePath` resolves to a location at or beneath
 * `rootPath`. The candidate may be relative; it is `resolve()`d before the
 * containment check. The root itself counts as inside (relative path is the
 * empty string).
 *
 * Used to guard manifest-driven file access from path-traversal entries like
 * `../../.git/config`.
 */
export function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relPath = relative(rootPath, resolve(candidatePath));
  return (
    relPath === '' ||
    (relPath !== '..' &&
      !relPath.startsWith(`..${sep}`) &&
      !isAbsolute(relPath))
  );
}
