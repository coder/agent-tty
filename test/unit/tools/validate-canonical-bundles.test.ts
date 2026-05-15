import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BundleValidationResult } from '../../../src/tools/validate-bundle.js';

const mocks = vi.hoisted(() => ({
  validateBundle: vi.fn(),
  checkCatalogParity: vi.fn(),
}));

vi.mock('../../../src/tools/validate-bundle.js', () => ({
  validateBundle: mocks.validateBundle,
  checkCatalogParity: mocks.checkCatalogParity,
}));

import { validateCanonicalBundles } from '../../../src/tools/validate-canonical-bundles.js';

const CANONICAL_BUNDLE_COUNT = 4;

function passResult(bundlePath: string): BundleValidationResult {
  return {
    bundleDir: bundlePath,
    profile: 'canonical',
    ok: true,
    checks: [
      {
        name: 'manifest-exists',
        ok: true,
        message: 'Read manifest.json (123 bytes).',
      },
    ],
  };
}

function failResult(
  bundlePath: string,
  reason: string,
): BundleValidationResult {
  return {
    bundleDir: bundlePath,
    profile: 'canonical',
    ok: false,
    checks: [
      {
        name: 'artifacts-sha256-match',
        ok: false,
        message: reason,
      },
    ],
  };
}

let stderrChunks: string[];

beforeEach(() => {
  stderrChunks = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrChunks.push(
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString('utf8'),
    );
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateCanonicalBundles orchestrator', () => {
  it('returns 0 when every bundle and the catalog all pass', async () => {
    mocks.validateBundle.mockImplementation((bundlePath: string) =>
      Promise.resolve(passResult(bundlePath)),
    );
    mocks.checkCatalogParity.mockResolvedValue({ ok: true, missing: [] });

    const exitCode = await validateCanonicalBundles();

    expect(exitCode).toBe(0);
    expect(mocks.validateBundle).toHaveBeenCalledTimes(CANONICAL_BUNDLE_COUNT);
    expect(mocks.checkCatalogParity).toHaveBeenCalledTimes(1);
    const output = stderrChunks.join('');
    expect(output).toContain('validate-bundle PASS canonical:');
    expect(output).toContain(
      'catalog-parity PASS: every CATALOG.md entry resolves to a directory',
    );
  });

  it('returns 1 when a bundle reports ok: false', async () => {
    mocks.validateBundle.mockImplementation((bundlePath: string) => {
      if (bundlePath.endsWith('run-command')) {
        return Promise.resolve(failResult(bundlePath, 'sha256 mismatch: foo'));
      }
      return Promise.resolve(passResult(bundlePath));
    });
    mocks.checkCatalogParity.mockResolvedValue({ ok: true, missing: [] });

    const exitCode = await validateCanonicalBundles();

    expect(exitCode).toBe(1);
    const output = stderrChunks.join('');
    expect(output).toContain('validate-bundle FAIL canonical:');
    expect(output).toContain('run-command');
    expect(output).toContain('sha256 mismatch: foo');
  });

  it('synthesizes a validation-error check when a bundle validation throws', async () => {
    mocks.validateBundle.mockImplementation((bundlePath: string) => {
      if (bundlePath.endsWith('run-command')) {
        return Promise.reject(new Error('boom: stream destroyed'));
      }
      return Promise.resolve(passResult(bundlePath));
    });
    mocks.checkCatalogParity.mockResolvedValue({ ok: true, missing: [] });

    const exitCode = await validateCanonicalBundles();

    expect(exitCode).toBe(1);
    const output = stderrChunks.join('');
    expect(output).toContain(
      'validate-bundle FAIL canonical: dogfood/run-command',
    );
    expect(output).toContain('validation-error');
    expect(output).toContain('Bundle validation crashed');
    expect(output).toContain('boom: stream destroyed');
    // The other three bundles still produced their PASS lines; a single
    // crash does not abort the whole batch.
    expect(output.match(/validate-bundle PASS canonical:/g)).toHaveLength(3);
  });

  it('returns 1 when catalog parity reports missing entries', async () => {
    mocks.validateBundle.mockImplementation((bundlePath: string) =>
      Promise.resolve(passResult(bundlePath)),
    );
    mocks.checkCatalogParity.mockResolvedValue({
      ok: false,
      missing: ['stale-bundle'],
    });

    const exitCode = await validateCanonicalBundles();

    expect(exitCode).toBe(1);
    const output = stderrChunks.join('');
    expect(output).toContain(
      'catalog-parity FAIL: 1 CATALOG.md entry did not resolve',
    );
    expect(output).toContain('stale-bundle');
  });

  it('returns 1 and logs catalog-parity ERROR when checkCatalogParity throws', async () => {
    mocks.validateBundle.mockImplementation((bundlePath: string) =>
      Promise.resolve(passResult(bundlePath)),
    );
    mocks.checkCatalogParity.mockRejectedValue(
      new Error('EACCES: permission denied'),
    );

    const exitCode = await validateCanonicalBundles();

    expect(exitCode).toBe(1);
    const output = stderrChunks.join('');
    expect(output).toContain('catalog-parity ERROR');
    expect(output).toContain('EACCES: permission denied');
  });
});
