/**
 * Validates the four canonical proof bundles named in RELEASE.md against the
 * strict `canonical` profile, plus a CATALOG.md parity check.
 *
 * Run via `npm run validate-bundle:canonical` or `mise run validate-bundles`.
 */

import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

import { checkCatalogParity, validateBundle } from './validate-bundle.js';

const CANONICAL_BUNDLES = [
  'dogfood/20260326-week9-release-readiness',
  'dogfood/20260325-week8-contract-locks',
  'dogfood/run-command',
  'dogfood/agent-uses-agent-tty',
] as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function validateCanonicalBundles(): Promise<number> {
  const bundleResults = await Promise.all(
    CANONICAL_BUNDLES.map(async (relativeBundle) => {
      const bundlePath = resolve(REPO_ROOT, relativeBundle);
      const result = await validateBundle(bundlePath, 'canonical');
      return { relativeBundle, result };
    }),
  );

  let allOk = true;
  for (const { relativeBundle, result } of bundleResults) {
    const status = result.ok ? 'PASS' : 'FAIL';
    process.stderr.write(
      `validate-bundle ${status} canonical: ${relativeBundle}\n`,
    );
    for (const check of result.checks) {
      const mark = check.ok ? '✓' : '✗';
      process.stderr.write(`  ${mark} ${check.name}: ${check.message}\n`);
    }
    if (!result.ok) {
      allOk = false;
    }
  }

  const catalogResult = await checkCatalogParity(
    resolve(REPO_ROOT, 'dogfood/CATALOG.md'),
    resolve(REPO_ROOT, 'dogfood'),
  );
  if (catalogResult.ok) {
    process.stderr.write(
      'catalog-parity PASS: every CATALOG.md entry resolves to a directory\n',
    );
  } else {
    process.stderr.write(
      `catalog-parity FAIL: ${String(catalogResult.missing.length)} CATALOG.md entr${catalogResult.missing.length === 1 ? 'y' : 'ies'} did not resolve: ${catalogResult.missing.join(', ')}\n`,
    );
    allOk = false;
  }

  return allOk ? 0 : 1;
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isDirectExecution()) {
  const exitCode = await validateCanonicalBundles();
  process.exitCode = exitCode;
}
