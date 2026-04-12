import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { emitSuccess } from '../output.js';
import type { CapabilityEntry } from '../../renderer/capabilities.js';

import { discoverCapabilities } from '../../renderer/capabilities.js';
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
  capabilities?: CapabilityEntry[];
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

export async function buildVersionResult(options?: {
  includeCapabilities?: boolean;
}): Promise<VersionResult> {
  const packageMetadata = await loadPackageMetadata();
  let capabilities: CapabilityEntry[] | undefined;

  if (options?.includeCapabilities) {
    try {
      capabilities = await discoverCapabilities('quick');
    } catch (error: unknown) {
      // Capability discovery is best-effort for version; never crash.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `warning: capability discovery failed: ${message}\n`,
      );
      capabilities = undefined;
    }
  }

  return {
    cliVersion: packageMetadata.version,
    protocolVersion: PROTOCOL_VERSION,
    rendererBackends: ['ghostty-web'],
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

export async function runVersionCommand(options: {
  json: boolean;
}): Promise<void> {
  const result = await buildVersionResult({
    includeCapabilities: options.json,
  });

  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: [
      `agent-tty ${result.cliVersion}`,
      `protocol ${result.protocolVersion}`,
      `runtime ${result.runtime.node} (${result.runtime.platform}/${result.runtime.arch})`,
    ],
  });
}
