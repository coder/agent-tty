import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_JSON_FILE_BYTES,
  runValidateBundleCli,
  validateBundle,
  type BundleValidationCheck,
  type BundleValidationResult,
} from '../../../src/tools/validate-bundle.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  // oxfmt-ignore
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-validate-bundle-')));
  tempDirs.push(directory);
  return directory;
}

async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function findCheck(
  result: BundleValidationResult,
  checkName: string,
): BundleValidationCheck {
  const check = result.checks.find((candidate) => candidate.name === checkName);
  expect(check).toBeDefined();
  return check as BundleValidationCheck;
}

async function createContractBundle(): Promise<string> {
  const bundleRoot = await createTempDir();
  await writeFixtureFile(bundleRoot, 'index.html', '<!doctype html>\n');
  await writeFixtureFile(bundleRoot, 'notes.md', '# Notes\n');
  await writeFixtureFile(bundleRoot, '01-create.json', '{"ok":true}\n');
  return bundleRoot;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('validate-bundle', () => {
  it('passes contract-reporting bundles through the CLI with the default profile', async () => {
    const bundleRoot = await createContractBundle();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runValidateBundleCli([bundleRoot], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.join('')) as BundleValidationResult;
    expect(result.ok).toBe(true);
    expect(result.profile).toBe('contract-reporting');
    expect(findCheck(result, 'has-json-output').ok).toBe(true);
    expect(findCheck(result, 'has-review-page').ok).toBe(true);
    expect(findCheck(result, 'has-notes').ok).toBe(true);
    expect(findCheck(result, 'json-readable').ok).toBe(true);
    expect(stderr.join('')).toContain(
      'validate-bundle PASS contract-reporting',
    );
  });

  it('passes interactive-renderer bundles through the CLI', async () => {
    const bundleRoot = await createContractBundle();
    await writeFixtureFile(bundleRoot, 'screenshots/terminal.png', 'png-bytes');
    await writeFixtureFile(bundleRoot, 'recordings/session.cast', 'cast-bytes');
    await writeFixtureFile(bundleRoot, 'videos/session.webm', 'webm-bytes');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runValidateBundleCli(
      [bundleRoot, '--profile', 'interactive-renderer'],
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.join('')) as BundleValidationResult;
    expect(result.ok).toBe(true);
    expect(result.profile).toBe('interactive-renderer');
    expect(findCheck(result, 'has-screenshot').ok).toBe(true);
    expect(findCheck(result, 'has-recording').ok).toBe(true);
    expect(stderr.join('')).toContain(
      'validate-bundle PASS interactive-renderer',
    );
  });

  it('fails when the bundle directory is empty', async () => {
    const bundleRoot = await createTempDir();

    const result = await validateBundle(bundleRoot, 'contract-reporting');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'has-json-output').ok).toBe(false);
    expect(findCheck(result, 'has-review-page').ok).toBe(false);
    expect(findCheck(result, 'has-notes').ok).toBe(false);
    expect(findCheck(result, 'json-readable').ok).toBe(false);
  });

  it('fails when a contract-reporting bundle is missing notes', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(bundleRoot, 'index.html', '<!doctype html>\n');
    await writeFixtureFile(bundleRoot, '01-create.json', '{"ok":true}\n');

    const result = await validateBundle(bundleRoot, 'contract-reporting');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'has-json-output').ok).toBe(true);
    expect(findCheck(result, 'has-review-page').ok).toBe(true);
    expect(findCheck(result, 'has-notes').ok).toBe(false);
  });

  it('fails when a contract-reporting bundle is missing JSON output', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(bundleRoot, 'index.html', '<!doctype html>\n');
    await writeFixtureFile(bundleRoot, 'notes.md', '# Notes\n');

    const result = await validateBundle(bundleRoot, 'contract-reporting');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'has-json-output').ok).toBe(false);
  });

  it('fails when a contract-reporting bundle is missing a review page', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(bundleRoot, 'notes.md', '# Notes\n');
    await writeFixtureFile(bundleRoot, '01-create.json', '{"ok":true}\n');

    const result = await validateBundle(bundleRoot, 'contract-reporting');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'has-review-page').ok).toBe(false);
  });

  it('fails when a contract-reporting bundle has corrupt JSON output', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(bundleRoot, 'index.html', '<!doctype html>\n');
    await writeFixtureFile(bundleRoot, 'notes.md', '# Notes\n');
    await writeFixtureFile(bundleRoot, '01-create.json', '{not-json}\n');

    const result = await validateBundle(bundleRoot, 'contract-reporting');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'json-readable').ok).toBe(false);
    expect(findCheck(result, 'json-readable').message).toContain(
      '01-create.json',
    );
  });

  it('fails when a contract-reporting bundle has oversized JSON output', async () => {
    const bundleRoot = await createTempDir();
    const jsonPath = join(bundleRoot, '01-create.json');
    await writeFixtureFile(bundleRoot, 'index.html', '<!doctype html>\n');
    await writeFixtureFile(bundleRoot, 'notes.md', '# Notes\n');
    await writeFile(jsonPath, '{', 'utf8');
    await truncate(jsonPath, MAX_JSON_FILE_BYTES + 1);

    const result = await validateBundle(bundleRoot, 'contract-reporting');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'has-json-output').ok).toBe(true);
    expect(findCheck(result, 'json-readable').ok).toBe(false);
    expect(findCheck(result, 'json-readable').message).toContain(
      '01-create.json',
    );
    expect(findCheck(result, 'json-readable').message).toContain(
      String(MAX_JSON_FILE_BYTES),
    );
  });

  it('fails interactive-renderer bundles that are missing screenshots', async () => {
    const bundleRoot = await createContractBundle();
    await writeFixtureFile(bundleRoot, 'recordings/session.cast', 'cast-bytes');

    const result = await validateBundle(bundleRoot, 'interactive-renderer');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'has-screenshot').ok).toBe(false);
    expect(findCheck(result, 'has-recording').ok).toBe(true);
  });

  it('fails interactive-renderer bundles that are missing recordings', async () => {
    const bundleRoot = await createContractBundle();
    await writeFixtureFile(bundleRoot, 'screenshots/terminal.png', 'png-bytes');

    const result = await validateBundle(bundleRoot, 'interactive-renderer');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'has-screenshot').ok).toBe(true);
    expect(findCheck(result, 'has-recording').ok).toBe(false);
  });

  it('fails when the bundle directory does not exist', async () => {
    const missingBundleRoot = join(
      tmpdir(),
      'agent-tty-validate-bundle-does-not-exist',
    );

    const result = await validateBundle(
      missingBundleRoot,
      'contract-reporting',
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(findCheck(result, 'bundle-exists').ok).toBe(false);
  });
});
