import { readFile } from 'node:fs/promises';

import { assertString } from './assert.js';

export interface PackageMetadata {
  name: string;
  version: string;
}

/**
 * Reads the root `package.json` (resolved relative to this module's disk
 * location, not the caller's) and returns the package name and version.
 * Throws when the file is missing or when `name` / `version` is absent or
 * non-string. Callers that need a tolerant fallback should wrap the call in
 * `.catch()`.
 */
export async function loadPackageMetadata(): Promise<PackageMetadata> {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const rawPackageJson = await readFile(packageJsonUrl, 'utf8');
  const parsedPackageJson = JSON.parse(rawPackageJson) as Record<
    string,
    unknown
  >;
  const packageName = parsedPackageJson.name;
  const packageVersion = parsedPackageJson.version;

  assertString(packageName, 'package.json name must be a string');
  assertString(packageVersion, 'package.json version must be a string');

  return {
    name: packageName,
    version: packageVersion,
  };
}
