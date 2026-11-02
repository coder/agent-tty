import { readFile } from 'node:fs/promises';

import { assertString, invariant } from './assert.js';

export interface PackageMetadata {
  name: string;
  version: string;
}

async function readPackageJson(): Promise<Record<string, unknown>> {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const rawPackageJson = await readFile(packageJsonUrl, 'utf8');
  return JSON.parse(rawPackageJson) as Record<string, unknown>;
}

/**
 * Reads the root `package.json` (resolved relative to this module's disk
 * location, not the caller's) and returns the package name and version.
 * Throws when the file is missing or when `name` / `version` is absent or
 * non-string. Callers that need a tolerant fallback should wrap the call in
 * `.catch()`.
 */
export async function loadPackageMetadata(): Promise<PackageMetadata> {
  const parsedPackageJson = await readPackageJson();
  const packageName = parsedPackageJson.name;
  const packageVersion = parsedPackageJson.version;

  assertString(packageName, 'package.json name must be a string');
  assertString(packageVersion, 'package.json version must be a string');

  return {
    name: packageName,
    version: packageVersion,
  };
}

export async function loadSupportedNodeRange(): Promise<string> {
  const { engines } = await readPackageJson();
  invariant(
    typeof engines === 'object' && engines !== null,
    'package.json engines must be an object',
  );
  const range = (engines as Record<string, unknown>).node;
  assertString(range, 'package.json engines.node must be a string');
  return range;
}
