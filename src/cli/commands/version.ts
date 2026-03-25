import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { emitSuccess } from '../output.js';
import { assertString } from '../../util/assert.js';

const COMMAND_NAME = 'version';
const PROTOCOL_VERSION = '0.1.0';

interface PackageMetadata {
  name: string;
  version: string;
}

export interface VersionResult {
  cliVersion: string;
  protocolVersion: string;
  rendererBackends: string[];
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
}

export async function loadPackageMetadata(): Promise<PackageMetadata> {
  const packageJsonUrl = new URL('../../../package.json', import.meta.url);
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

export async function buildVersionResult(): Promise<VersionResult> {
  const packageMetadata = await loadPackageMetadata();

  return {
    cliVersion: packageMetadata.version,
    protocolVersion: PROTOCOL_VERSION,
    rendererBackends: ['ghostty-web'],
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export async function runVersionCommand(options: {
  json: boolean;
}): Promise<void> {
  const result = await buildVersionResult();

  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: [
      `agent-terminal ${result.cliVersion}`,
      `protocol ${result.protocolVersion}`,
      `runtime ${result.runtime.node} (${result.runtime.platform}/${result.runtime.arch})`,
    ],
  });
}
