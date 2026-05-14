import { readFile } from 'node:fs/promises';

import { assertString } from './assert.js';

export interface PackageMetadata {
  name: string;
  version: string;
}

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
