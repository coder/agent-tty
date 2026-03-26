/**
 * Bundle validation tool — validates proof-bundle completeness.
 *
 * Usage: npm run validate-bundle -- <bundle-dir> [--profile <profile>]
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { scanBundleArtifacts } from './review-bundle.js';
import { assertString, invariant } from '../util/assert.js';

const BUNDLE_VALIDATION_PROFILES = [
  'contract-reporting',
  'interactive-renderer',
] as const;

export type BundleValidationProfile =
  | 'contract-reporting'
  | 'interactive-renderer';

export interface BundleValidationResult {
  bundleDir: string;
  profile: BundleValidationProfile;
  ok: boolean;
  checks: BundleValidationCheck[];
}

export interface BundleValidationCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface BundleValidationIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function defaultIo(): BundleValidationIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function writeLine(write: (text: string) => void, line: string): void {
  write(`${line}\n`);
}

function buildCheck(
  name: string,
  ok: boolean,
  message: string,
): BundleValidationCheck {
  return { name, ok, message };
}

function isBundleValidationProfile(
  value: string,
): value is BundleValidationProfile {
  return BUNDLE_VALIDATION_PROFILES.includes(value as BundleValidationProfile);
}

/** Maximum size for JSON files in a bundle (50 MB, matching event-log limit). */
export const MAX_JSON_FILE_BYTES = 50 * 1024 * 1024;

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function buildJsonReadableCheck(
  bundleRoot: string,
  jsonArtifacts: Array<{ relativePath: string }>,
): Promise<BundleValidationCheck> {
  if (jsonArtifacts.length === 0) {
    return buildCheck(
      'json-readable',
      false,
      'No JSON output files were found to parse.',
    );
  }

  const invalidJsonPaths: string[] = [];
  const oversizedJsonPaths: string[] = [];
  for (const artifact of jsonArtifacts) {
    const filePath = join(bundleRoot, artifact.relativePath);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_JSON_FILE_BYTES) {
        oversizedJsonPaths.push(artifact.relativePath);
        continue;
      }
      const content = await readFile(filePath, 'utf8');
      JSON.parse(content) as unknown;
    } catch {
      invalidJsonPaths.push(artifact.relativePath);
    }
  }

  if (oversizedJsonPaths.length > 0) {
    return buildCheck(
      'json-readable',
      false,
      `JSON output files exceed ${String(MAX_JSON_FILE_BYTES)} byte limit: ${oversizedJsonPaths.join(', ')}`,
    );
  }

  if (invalidJsonPaths.length > 0) {
    return buildCheck(
      'json-readable',
      false,
      `JSON output files could not be parsed: ${invalidJsonPaths.join(', ')}`,
    );
  }

  return buildCheck(
    'json-readable',
    true,
    `Parsed ${String(jsonArtifacts.length)} JSON output file(s).`,
  );
}

function summarizeValidation(result: BundleValidationResult): string[] {
  const status = result.ok ? 'PASS' : 'FAIL';
  return [
    `validate-bundle ${status} ${result.profile}: ${result.bundleDir}`,
    ...result.checks.map(
      (check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.message}`,
    ),
  ];
}

export async function validateBundle(
  bundleDir: string,
  profile: BundleValidationProfile,
): Promise<BundleValidationResult> {
  assertString(bundleDir, 'bundle directory must be a string');
  invariant(bundleDir.trim().length > 0, 'bundle directory must not be empty');
  invariant(
    isBundleValidationProfile(profile),
    `unsupported bundle validation profile: ${profile}`,
  );

  const resolvedBundleDir = resolve(bundleDir);
  const checks: BundleValidationCheck[] = [];

  try {
    const bundleStats = await stat(resolvedBundleDir);
    if (!bundleStats.isDirectory()) {
      checks.push(
        buildCheck(
          'bundle-exists',
          false,
          `Bundle path is not a directory: ${resolvedBundleDir}`,
        ),
      );
      return {
        bundleDir: resolvedBundleDir,
        profile,
        ok: false,
        checks,
      };
    }
  } catch (error) {
    checks.push(
      buildCheck(
        'bundle-exists',
        false,
        `Bundle directory could not be read: ${String(error)}`,
      ),
    );
    return {
      bundleDir: resolvedBundleDir,
      profile,
      ok: false,
      checks,
    };
  }

  const bundleRoot = await realpath(resolvedBundleDir);
  checks.push(
    buildCheck(
      'bundle-exists',
      true,
      `Bundle directory is readable: ${bundleRoot}`,
    ),
  );

  const artifacts = await scanBundleArtifacts(bundleRoot);
  const jsonArtifacts = artifacts.filter(
    (artifact) => artifact.kind === 'json',
  );
  const noteArtifacts = artifacts.filter(
    (artifact) => artifact.kind === 'notes',
  );
  const screenshotArtifacts = artifacts.filter(
    (artifact) => artifact.kind === 'screenshot',
  );
  const recordingArtifacts = artifacts.filter(
    (artifact) => artifact.kind === 'recording',
  );

  checks.push(
    buildCheck(
      'has-json-output',
      jsonArtifacts.length > 0,
      jsonArtifacts.length > 0
        ? `Found ${String(jsonArtifacts.length)} JSON output file(s).`
        : 'Expected at least one JSON output file.',
    ),
  );

  const reviewPagePath = join(bundleRoot, 'index.html');
  const hasReviewPage = await isFile(reviewPagePath);
  checks.push(
    buildCheck(
      'has-review-page',
      hasReviewPage,
      hasReviewPage
        ? 'Found review page index.html.'
        : 'Expected index.html review page in the bundle root.',
    ),
  );

  checks.push(
    buildCheck(
      'has-notes',
      noteArtifacts.length > 0,
      noteArtifacts.length > 0
        ? `Found ${String(noteArtifacts.length)} note file(s).`
        : 'Expected at least one notes markdown file.',
    ),
  );

  checks.push(await buildJsonReadableCheck(bundleRoot, jsonArtifacts));

  if (profile === 'interactive-renderer') {
    checks.push(
      buildCheck(
        'has-screenshot',
        screenshotArtifacts.length > 0,
        screenshotArtifacts.length > 0
          ? `Found ${String(screenshotArtifacts.length)} screenshot file(s).`
          : 'Expected at least one screenshot artifact.',
      ),
    );
    checks.push(
      buildCheck(
        'has-recording',
        recordingArtifacts.length > 0,
        recordingArtifacts.length > 0
          ? `Found ${String(recordingArtifacts.length)} recording file(s).`
          : 'Expected at least one recording (.cast) artifact.',
      ),
    );
  }

  return {
    bundleDir: bundleRoot,
    profile,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export async function runValidateBundleCli(
  args: readonly string[],
  io: BundleValidationIo = defaultIo(),
): Promise<number> {
  const argumentsList = [...args];
  if (argumentsList.length === 0) {
    writeLine(
      io.stderr,
      'Usage: npm run validate-bundle -- <bundle-dir> [--profile <profile>]',
    );
    return 1;
  }

  let bundleDir: string | undefined;
  let profile: BundleValidationProfile = 'contract-reporting';

  while (argumentsList.length > 0) {
    const argument = argumentsList.shift();
    invariant(
      argument !== undefined,
      'argument must exist while parsing CLI args',
    );

    if (argument === '--profile') {
      const profileArgument = argumentsList.shift();
      if (
        profileArgument === undefined ||
        !isBundleValidationProfile(profileArgument)
      ) {
        writeLine(
          io.stderr,
          `Expected --profile to be one of: ${BUNDLE_VALIDATION_PROFILES.join(', ')}`,
        );
        return 1;
      }
      profile = profileArgument;
      continue;
    }

    if (argument.startsWith('--')) {
      writeLine(io.stderr, `Unknown option: ${argument}`);
      return 1;
    }

    if (bundleDir !== undefined) {
      writeLine(io.stderr, 'Expected exactly one bundle directory');
      return 1;
    }
    bundleDir = argument;
  }

  if (bundleDir === undefined) {
    writeLine(
      io.stderr,
      'Usage: npm run validate-bundle -- <bundle-dir> [--profile <profile>]',
    );
    return 1;
  }

  let result: BundleValidationResult;
  try {
    result = await validateBundle(bundleDir, profile);
  } catch (error) {
    result = {
      bundleDir: resolve(bundleDir),
      profile,
      ok: false,
      checks: [
        buildCheck(
          'validation-error',
          false,
          `Bundle validation crashed: ${String(error)}`,
        ),
      ],
    };
  }

  writeLine(io.stdout, JSON.stringify(result, null, 2));
  for (const line of summarizeValidation(result)) {
    writeLine(io.stderr, line);
  }
  return result.ok ? 0 : 1;
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isDirectExecution()) {
  const exitCode = await runValidateBundleCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
