/**
 * Validates the four canonical proof bundles against the strict `canonical`
 * profile, plus a CATALOG.md parity check.
 *
 * RELEASE.md's validation section names the three release-signoff bundles
 * (`20260326-week9-release-readiness`, `20260325-week8-contract-locks`,
 * `run-command`). `agent-uses-agent-tty` is the evergreen agent demo bundle
 * (surfaced in the README and `CHANGELOG.md` rather than `RELEASE.md`),
 * locked here on the same schema so CI catches drift in the same place.
 *
 * Run via `npm run validate-bundle:canonical` or `mise run validate-bundles`.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  checkCatalogParity,
  validateBundle,
  type BundleValidationResult,
} from './validate-bundle.js';
import { isDirectExecution } from '../util/isDirectExecution.js';

const CANONICAL_BUNDLES = [
  'dogfood/20260326-week9-release-readiness',
  'dogfood/20260325-week8-contract-locks',
  'dogfood/run-command',
  'dogfood/agent-uses-agent-tty',
] as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function synthesizeCrashResult(
  bundlePath: string,
  error: unknown,
): BundleValidationResult {
  return {
    bundleDir: bundlePath,
    profile: 'canonical',
    ok: false,
    checks: [
      {
        name: 'validation-error',
        ok: false,
        message: `Bundle validation crashed: ${String(error)}`,
      },
    ],
  };
}

export async function validateCanonicalBundles(): Promise<number> {
  const bundleResults = await Promise.all(
    CANONICAL_BUNDLES.map(async (relativeBundle) => {
      const bundlePath = resolve(REPO_ROOT, relativeBundle);
      try {
        const result = await validateBundle(bundlePath, 'canonical');
        return { relativeBundle, result };
      } catch (error) {
        return {
          relativeBundle,
          result: synthesizeCrashResult(bundlePath, error),
        };
      }
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

  try {
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
  } catch (error) {
    process.stderr.write(`catalog-parity ERROR: ${String(error)}\n`);
    allOk = false;
  }

  return allOk ? 0 : 1;
}

if (isDirectExecution(import.meta.url)) {
  const exitCode = await validateCanonicalBundles();
  process.exitCode = exitCode;
}
