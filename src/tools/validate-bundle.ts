/**
 * Bundle validation tool — validates proof-bundle completeness.
 *
 * Usage: npm run validate-bundle -- <bundle-dir> [--profile <profile>]
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { CanonicalBundleManifestSchema } from './bundleManifestSchema.js';
import { scanBundleArtifacts } from './review-bundle.js';
import { assertString, invariant } from '../util/assert.js';

const BUNDLE_VALIDATION_PROFILES = [
  'contract-reporting',
  'interactive-renderer',
  'canonical',
] as const;

export type BundleValidationProfile =
  (typeof BUNDLE_VALIDATION_PROFILES)[number];

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

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolvePromise(hash.digest('hex'));
    });
    stream.on('error', (error) => {
      stream.destroy();
      rejectPromise(error);
    });
  });
}

async function runCanonicalChecks(
  bundleRoot: string,
): Promise<BundleValidationCheck[]> {
  const checks: BundleValidationCheck[] = [];

  const manifestPath = join(bundleRoot, 'manifest.json');
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch (error) {
    checks.push(
      buildCheck(
        'manifest-exists',
        false,
        `Could not read manifest.json: ${String(error)}`,
      ),
    );
    return checks;
  }
  checks.push(
    buildCheck(
      'manifest-exists',
      true,
      `Read manifest.json (${String(manifestText.length)} bytes).`,
    ),
  );

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch (error) {
    checks.push(
      buildCheck(
        'manifest-parses',
        false,
        `manifest.json is not valid JSON: ${String(error)}`,
      ),
    );
    return checks;
  }

  const parseResult = CanonicalBundleManifestSchema.safeParse(manifestJson);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    checks.push(
      buildCheck(
        'manifest-parses',
        false,
        `manifest.json does not match CanonicalBundleManifestSchema: ${issues}`,
      ),
    );
    return checks;
  }
  const manifest = parseResult.data;
  checks.push(
    buildCheck(
      'manifest-parses',
      true,
      `Manifest matches schema (${String(manifest.artifacts.length)} artifact entr${manifest.artifacts.length === 1 ? 'y' : 'ies'}).`,
    ),
  );

  const missingArtifacts: string[] = [];
  const sizeMismatches: string[] = [];
  const hashMismatches: string[] = [];

  for (const artifact of manifest.artifacts) {
    const artifactPath = join(bundleRoot, artifact.path);
    let stats;
    try {
      stats = await stat(artifactPath);
    } catch {
      missingArtifacts.push(artifact.path);
      continue;
    }
    if (!stats.isFile()) {
      missingArtifacts.push(artifact.path);
      continue;
    }
    if (stats.size !== artifact.bytes) {
      sizeMismatches.push(
        `${artifact.path} (manifest: ${String(artifact.bytes)}, on-disk: ${String(stats.size)})`,
      );
      continue;
    }
    const actualHash = await hashFile(artifactPath);
    if (actualHash !== artifact.sha256) {
      hashMismatches.push(
        `${artifact.path} (manifest: ${artifact.sha256}, on-disk: ${actualHash})`,
      );
    }
  }

  checks.push(
    buildCheck(
      'artifacts-present',
      missingArtifacts.length === 0,
      missingArtifacts.length === 0
        ? `All ${String(manifest.artifacts.length)} artifact(s) present as regular files.`
        : `Missing: ${missingArtifacts.join(', ')}`,
    ),
  );

  checks.push(
    buildCheck(
      'artifacts-bytes-match',
      sizeMismatches.length === 0,
      sizeMismatches.length === 0
        ? 'All artifact byte sizes match the manifest.'
        : `Byte-size mismatches: ${sizeMismatches.join('; ')}`,
    ),
  );

  checks.push(
    buildCheck(
      'artifacts-sha256-match',
      hashMismatches.length === 0,
      hashMismatches.length === 0
        ? 'All artifact sha256 digests match the manifest.'
        : `sha256 mismatches: ${hashMismatches.join('; ')}`,
    ),
  );

  const commandsShPath = join(bundleRoot, 'commands.sh');
  const reproduceShPath = join(bundleRoot, 'reproduce.sh');
  const hasCommandsSh =
    (await isFile(commandsShPath)) || (await isFile(reproduceShPath));
  checks.push(
    buildCheck(
      'commands-sh-exists',
      hasCommandsSh,
      hasCommandsSh
        ? 'Found commands.sh or reproduce.sh.'
        : 'Expected commands.sh or reproduce.sh in the bundle root.',
    ),
  );

  if (manifest.result === 'pass') {
    const tsvPath = join(bundleRoot, 'command-status.tsv');
    const tsvExists = await isFile(tsvPath);
    if (tsvExists) {
      const tsvContent = await readFile(tsvPath, 'utf8');
      const lines = tsvContent.split('\n').filter((line) => line.length > 0);
      const headerColumns = lines[0]?.split('\t') ?? [];
      const hasHeader = headerColumns.length > 1;
      const dataLines = lines.slice(1);
      const failingRows = dataLines.filter((line) => {
        const columns = line.split('\t');
        return columns.some((cell) => cell.trim() === 'fail');
      });
      checks.push(
        buildCheck(
          'command-status-tsv-clean-if-pass',
          hasHeader && failingRows.length === 0,
          hasHeader && failingRows.length === 0
            ? `command-status.tsv has a header and no failing rows (${String(dataLines.length)} data row(s)).`
            : !hasHeader
              ? 'command-status.tsv is missing a header row.'
              : `command-status.tsv has ${String(failingRows.length)} failing row(s).`,
        ),
      );
    } else {
      checks.push(
        buildCheck(
          'command-status-tsv-clean-if-pass',
          true,
          'command-status.tsv not present (scenario bundle); skipping.',
        ),
      );
    }
  }

  const hasNotes =
    (await isFile(join(bundleRoot, 'notes.md'))) ||
    (await isFile(join(bundleRoot, 'README.md')));
  checks.push(
    buildCheck(
      'notes-or-readme-present',
      hasNotes,
      hasNotes
        ? 'Found notes.md or README.md.'
        : 'Expected notes.md or README.md in the bundle root.',
    ),
  );

  return checks;
}

export interface CatalogParityResult {
  ok: boolean;
  missing: string[];
}

export async function checkCatalogParity(
  catalogPath: string,
  dogfoodRoot: string,
): Promise<CatalogParityResult> {
  const catalogText = await readFile(catalogPath, 'utf8');
  const dogfoodRelativeName = relative(resolve(dogfoodRoot, '..'), dogfoodRoot);
  const escapedPrefix = dogfoodRelativeName.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  // Match `dogfood/<name>/...` paths in CATALOG.md only when they include a
  // trailing path component (i.e. end with `/` after the bundle name). This
  // skips glob-shaped entries like `dogfood/20260319-*` which truncate at the
  // `*` and would otherwise look like real directories.
  const pathRegex = new RegExp(
    `${escapedPrefix}\\/([A-Za-z0-9._][A-Za-z0-9._-]*)\\/`,
    'g',
  );
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const match of catalogText.matchAll(pathRegex)) {
    const firstSegment = match[1];
    if (firstSegment === undefined || firstSegment.length === 0) {
      continue;
    }
    if (firstSegment.endsWith('-')) {
      continue;
    }
    if (seen.has(firstSegment)) {
      continue;
    }
    seen.add(firstSegment);
    const dirPath = join(dogfoodRoot, firstSegment);
    try {
      const stats = await stat(dirPath);
      if (!stats.isDirectory()) {
        missing.push(firstSegment);
      }
    } catch {
      missing.push(firstSegment);
    }
  }
  return { ok: missing.length === 0, missing };
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

  if (profile === 'canonical') {
    const canonicalChecks = await runCanonicalChecks(bundleRoot);
    checks.push(...canonicalChecks);
    return {
      bundleDir: bundleRoot,
      profile,
      ok: checks.every((check) => check.ok),
      checks,
    };
  }

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
