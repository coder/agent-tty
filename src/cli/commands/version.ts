import process from 'node:process';

import { emitSuccess } from '../output.js';
import type { CapabilityEntry } from '../../renderer/capabilities.js';

import { discoverCapabilities } from '../../renderer/capabilities.js';
import { RendererNameSchema } from '../../renderer/names.js';
import { loadPackageMetadata } from '../../util/packageMetadata.js';

const COMMAND_NAME = 'version';
const PROTOCOL_VERSION = '0.1.0';

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
    rendererBackends: [...RendererNameSchema.options],
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
