import { describe, expect, it, vi } from 'vitest';

import * as capabilitiesModule from '../../../src/renderer/capabilities.js';
import {
  buildVersionResult,
  loadPackageMetadata,
} from '../../../src/cli/commands/version.js';

describe('version command', () => {
  it('loads package metadata', async () => {
    const packageMetadata = await loadPackageMetadata();

    expect(packageMetadata.name).toBe('agent-terminal');
    expect(packageMetadata.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('builds the version result without capabilities by default', async () => {
    const result = await buildVersionResult();

    expect(result.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.protocolVersion).toBe('0.1.0');
    expect(result.rendererBackends).toEqual(['ghostty-web']);
    expect(result.runtime.node).toMatch(/^v\d+\.\d+\.\d+$/);
    expect('capabilities' in result).toBe(false);
  });

  it('builds the version result with runtime capabilities when requested', async () => {
    const result = await buildVersionResult({ includeCapabilities: true });

    expect(result.capabilities).toHaveLength(5);
    expect(result.capabilities?.map((capability) => capability.name)).toEqual([
      'snapshot',
      'wait',
      'screenshot',
      'record-export-asciicast',
      'record-export-webm',
    ]);
    expect(
      result.capabilities?.find(({ name }) => name === 'snapshot'),
    ).toEqual({
      name: 'snapshot',
      status: 'available',
    });
  });

  it('degrades gracefully when capability discovery fails', async () => {
    vi.spyOn(capabilitiesModule, 'discoverCapabilities').mockRejectedValueOnce(
      new Error('unexpected failure'),
    );
    const stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockReturnValue(true);

    const result = await buildVersionResult({ includeCapabilities: true });

    expect(result.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.protocolVersion).toBe('0.1.0');
    expect(result.rendererBackends).toEqual(['ghostty-web']);
    expect(result.runtime.node).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(result.runtime.platform).toBe(process.platform);
    expect(result.runtime.arch).toBe(process.arch);
    expect(result.capabilities).toBeUndefined();
    expect('capabilities' in result).toBe(false);
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      'warning: capability discovery failed: unexpected failure\n',
    );
  });
});
