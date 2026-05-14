import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Returns `true` when the calling module is the script being executed directly
 * (e.g. `node path/to/file.mjs` or `tsx path/to/file.ts`), rather than
 * imported. Pass `import.meta.url` from the caller; it cannot be resolved
 * from here because every module has its own.
 */
export function isDirectExecution(importMetaUrl: string): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  return importMetaUrl === pathToFileURL(entryPoint).href;
}
