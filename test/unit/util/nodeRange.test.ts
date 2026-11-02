import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { satisfiesNodeRange } from '../../../src/util/nodeRange.js';
import { loadSupportedNodeRange } from '../../../src/util/packageMetadata.js';

describe('satisfiesNodeRange', () => {
  it.each([
    ['22.23.2', false],
    ['23.99.99', false],
    ['24.0.0', true],
    ['26.12.1', true],
    ['27.0.0', false],
    ['27.0.0-nightly20261101', false],
  ])('checks Node %s against >=24.0.0 <27', (version, expected) => {
    expect(satisfiesNodeRange(version, '>=24.0.0 <27')).toBe(expected);
  });

  it.each(['^24', '24.x', '>=24 || >=26', '>24.0.0'])(
    'rejects the unsupported range %s',
    (range) => {
      expect(() => satisfiesNodeRange('24.0.0', range)).toThrow(range);
    },
  );

  it('reads a range from package.json that the test runtime satisfies', async () => {
    const range = await loadSupportedNodeRange();
    expect(satisfiesNodeRange(process.versions.node, range)).toBe(true);
  });
});
