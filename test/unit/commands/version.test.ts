import { describe, expect, it } from 'vitest';

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

  it('builds the version result', async () => {
    const result = await buildVersionResult();

    expect(result.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.protocolVersion).toBe('0.1.0');
    expect(result.rendererBackends).toEqual(['ghostty-web']);
    expect(result.runtime.node).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});
