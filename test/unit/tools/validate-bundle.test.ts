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

import { createHash } from 'node:crypto';

import {
  checkCatalogParity,
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

interface CanonicalArtifactFixture {
  path: string;
  description: string;
  content: string;
}

interface CanonicalManifestOptions {
  commands?: string[];
  result?: 'pass' | 'fail' | 'partial';
  scenario?: string;
  week?: number;
  extraFields?: Record<string, unknown>;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function writeCanonicalBundle(
  artifacts: CanonicalArtifactFixture[],
  options: CanonicalManifestOptions = {},
): Promise<string> {
  const bundleRoot = await createTempDir();
  for (const artifact of artifacts) {
    await writeFixtureFile(bundleRoot, artifact.path, artifact.content);
  }
  const manifest = {
    bundle: 'fixture-bundle',
    title: 'Fixture bundle',
    description: 'Fixture canonical bundle for validate-bundle tests',
    createdAt: '2026-05-14T00:00:00Z',
    scenario: options.scenario ?? 'fixture-bundle',
    ...(options.week !== undefined ? { week: options.week } : {}),
    result: options.result ?? 'pass',
    commands: options.commands ?? ['echo test'],
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      description: artifact.description,
      sha256: sha256Hex(artifact.content),
      bytes: Buffer.byteLength(artifact.content, 'utf8'),
    })),
    ...options.extraFields,
  };
  await writeFixtureFile(
    bundleRoot,
    'manifest.json',
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return bundleRoot;
}

describe('validate-bundle canonical profile', () => {
  it('passes a well-formed canonical bundle', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
      {
        path: 'commands.sh',
        description: 'reproduce',
        content: '#!/bin/sh\necho test\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{"ok":true}\n',
      },
    ]);

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(true);
    expect(result.profile).toBe('canonical');
    expect(findCheck(result, 'manifest-exists').ok).toBe(true);
    expect(findCheck(result, 'manifest-parses').ok).toBe(true);
    expect(findCheck(result, 'artifacts-present').ok).toBe(true);
    expect(findCheck(result, 'artifacts-bytes-match').ok).toBe(true);
    expect(findCheck(result, 'artifacts-sha256-match').ok).toBe(true);
    expect(findCheck(result, 'reproduce-script-exists').ok).toBe(true);
    expect(findCheck(result, 'notes-or-readme-present').ok).toBe(true);
  });

  it('accepts reproduce.sh in place of commands.sh', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'README.md', description: 'narrative', content: '# Bundle\n' },
      {
        path: 'reproduce.sh',
        description: 'reproduce',
        content: '#!/bin/sh\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{}\n',
      },
    ]);

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(true);
    expect(findCheck(result, 'reproduce-script-exists').ok).toBe(true);
    expect(findCheck(result, 'notes-or-readme-present').ok).toBe(true);
  });

  it('fails fast when manifest.json is missing', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(bundleRoot, 'notes.md', '# Notes\n');
    await writeFixtureFile(bundleRoot, 'commands.sh', '#!/bin/sh\n');

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'manifest-exists').ok).toBe(false);
    expect(
      result.checks.some((check) => check.name === 'manifest-parses'),
    ).toBe(false);
  });

  it('fails when manifest.json is not valid JSON', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(bundleRoot, 'manifest.json', '{not json}\n');

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'manifest-exists').ok).toBe(true);
    expect(findCheck(result, 'manifest-parses').ok).toBe(false);
    expect(findCheck(result, 'manifest-parses').message).toContain(
      'not valid JSON',
    );
  });

  it('fails when manifest.json does not match the canonical schema', async () => {
    const bundleRoot = await createTempDir();
    await writeFixtureFile(
      bundleRoot,
      'manifest.json',
      JSON.stringify({ bundle: 'incomplete' }),
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'manifest-parses').ok).toBe(false);
    expect(findCheck(result, 'manifest-parses').message).toContain(
      'CanonicalBundleManifestSchema',
    );
  });

  it('fails when a manifest artifact is missing on disk', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
      {
        path: 'commands.sh',
        description: 'reproduce',
        content: '#!/bin/sh\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{}\n',
      },
    ]);
    await rm(join(bundleRoot, 'envelope.json'));

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'artifacts-present').ok).toBe(false);
    expect(findCheck(result, 'artifacts-present').message).toContain(
      'envelope.json',
    );
  });

  it('fails when an artifact byte size disagrees with the manifest', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
      {
        path: 'commands.sh',
        description: 'reproduce',
        content: '#!/bin/sh\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{}\n',
      },
    ]);
    await writeFile(
      join(bundleRoot, 'envelope.json'),
      '{"changed":true}\n',
      'utf8',
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'artifacts-bytes-match').ok).toBe(false);
    expect(findCheck(result, 'artifacts-bytes-match').message).toContain(
      'envelope.json',
    );
  });

  it('fails when an artifact sha256 disagrees with the manifest', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
      {
        path: 'commands.sh',
        description: 'reproduce',
        content: '#!/bin/sh\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        // Original content is exactly 3 bytes ('{}\n'); replacement is also 3
        // bytes so size matches but sha256 differs.
        content: '{}\n',
      },
    ]);
    await writeFile(join(bundleRoot, 'envelope.json'), 'xx\n', 'utf8');

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'artifacts-bytes-match').ok).toBe(true);
    expect(findCheck(result, 'artifacts-sha256-match').ok).toBe(false);
    expect(findCheck(result, 'artifacts-sha256-match').message).toContain(
      'envelope.json',
    );
  });

  it('fails when neither commands.sh nor reproduce.sh is present', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{}\n',
      },
    ]);

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'reproduce-script-exists').ok).toBe(false);
  });

  it('fails when neither notes.md nor README.md is present', async () => {
    const bundleRoot = await writeCanonicalBundle([
      {
        path: 'commands.sh',
        description: 'reproduce',
        content: '#!/bin/sh\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{}\n',
      },
    ]);

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'notes-or-readme-present').ok).toBe(false);
  });

  it('skips command-status.tsv check when the file is absent on a passing bundle', async () => {
    const bundleRoot = await writeCanonicalBundle(
      [
        { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
        {
          path: 'commands.sh',
          description: 'reproduce',
          content: '#!/bin/sh\n',
        },
        {
          path: 'envelope.json',
          description: 'cli envelope',
          content: '{}\n',
        },
      ],
      { result: 'pass' },
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(true);
    expect(
      findCheck(result, 'command-status-tsv-clean-if-pass').message,
    ).toContain('not present');
  });

  it('fails when command-status.tsv has a failing row on a passing bundle', async () => {
    const bundleRoot = await writeCanonicalBundle(
      [
        { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
        {
          path: 'commands.sh',
          description: 'reproduce',
          content: '#!/bin/sh\n',
        },
        {
          path: 'envelope.json',
          description: 'cli envelope',
          content: '{}\n',
        },
      ],
      { result: 'pass' },
    );
    await writeFixtureFile(
      bundleRoot,
      'command-status.tsv',
      'step\tstatus\n01-create\tpass\n02-inspect\tfail\n',
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'command-status-tsv-clean-if-pass').ok).toBe(
      false,
    );
    expect(
      findCheck(result, 'command-status-tsv-clean-if-pass').message,
    ).toContain('1 failing row');
  });

  it('fails when command-status.tsv is missing a header on a passing bundle', async () => {
    const bundleRoot = await writeCanonicalBundle(
      [
        { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
        {
          path: 'commands.sh',
          description: 'reproduce',
          content: '#!/bin/sh\n',
        },
        {
          path: 'envelope.json',
          description: 'cli envelope',
          content: '{}\n',
        },
      ],
      { result: 'pass' },
    );
    await writeFixtureFile(
      bundleRoot,
      'command-status.tsv',
      'one-column-only\n',
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(
      findCheck(result, 'command-status-tsv-clean-if-pass').message,
    ).toContain('header row');
  });

  it('skips command-status.tsv check entirely for non-pass canonical bundles', async () => {
    const bundleRoot = await writeCanonicalBundle(
      [
        { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
        {
          path: 'commands.sh',
          description: 'reproduce',
          content: '#!/bin/sh\n',
        },
        {
          path: 'envelope.json',
          description: 'cli envelope',
          content: '{}\n',
        },
      ],
      { result: 'fail' },
    );
    await writeFixtureFile(
      bundleRoot,
      'command-status.tsv',
      'step\tstatus\nbroken\tfail\n',
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(
      result.checks.some(
        (check) => check.name === 'command-status-tsv-clean-if-pass',
      ),
    ).toBe(false);
  });

  it('ignores cells containing "fail" outside the status column', async () => {
    const bundleRoot = await writeCanonicalBundle(
      [
        { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
        {
          path: 'commands.sh',
          description: 'reproduce',
          content: '#!/bin/sh\n',
        },
        {
          path: 'envelope.json',
          description: 'cli envelope',
          content: '{}\n',
        },
      ],
      { result: 'pass' },
    );
    // Notes column mentions "fail" — must not trip the check.
    await writeFixtureFile(
      bundleRoot,
      'command-status.tsv',
      'step\tstatus\tnotes\n01-create\tpass\ttested fail path\n',
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(true);
    expect(findCheck(result, 'command-status-tsv-clean-if-pass').ok).toBe(true);
  });

  it('rejects artifacts whose paths escape the bundle root', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
      {
        path: 'commands.sh',
        description: 'reproduce',
        content: '#!/bin/sh\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{}\n',
      },
    ]);
    // Hand-craft a manifest with a path-traversal entry, overwriting the
    // helper-generated one.
    const escapingManifest = {
      bundle: 'fixture-bundle',
      title: 'Escaping fixture',
      description: 'Manifest with a path that resolves outside the bundle',
      createdAt: '2026-05-14T00:00:00Z',
      scenario: 'fixture-bundle',
      result: 'pass',
      commands: ['echo test'],
      artifacts: [
        {
          path: '../escape-target',
          description: 'evil',
          sha256:
            '0000000000000000000000000000000000000000000000000000000000000000',
          bytes: 0,
        },
      ],
    };
    await writeFile(
      join(bundleRoot, 'manifest.json'),
      `${JSON.stringify(escapingManifest, null, 2)}\n`,
      'utf8',
    );

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'artifacts-present').ok).toBe(false);
    expect(findCheck(result, 'artifacts-present').message).toContain(
      'escape bundle root',
    );
    expect(findCheck(result, 'artifacts-present').message).toContain(
      '../escape-target',
    );
  });

  it('reports byte-match counts that reflect skipped artifacts', async () => {
    const bundleRoot = await writeCanonicalBundle([
      { path: 'notes.md', description: 'narrative', content: '# Notes\n' },
      {
        path: 'commands.sh',
        description: 'reproduce',
        content: '#!/bin/sh\n',
      },
      {
        path: 'envelope.json',
        description: 'cli envelope',
        content: '{}\n',
      },
    ]);
    await rm(join(bundleRoot, 'envelope.json'));

    const result = await validateBundle(bundleRoot, 'canonical');

    expect(result.ok).toBe(false);
    expect(findCheck(result, 'artifacts-bytes-match').message).toContain(
      '2 of 3',
    );
    expect(findCheck(result, 'artifacts-sha256-match').message).toContain(
      '2 of 3',
    );
  });
});

describe('checkCatalogParity', () => {
  async function writeCatalogFixture(
    entries: string[],
    realDirectories: string[],
  ): Promise<{ catalogPath: string; dogfoodRoot: string }> {
    const repoRoot = await createTempDir();
    const dogfoodRoot = join(repoRoot, 'dogfood');
    await mkdir(dogfoodRoot, { recursive: true });
    for (const directory of realDirectories) {
      await mkdir(join(dogfoodRoot, directory), { recursive: true });
    }
    const catalogPath = join(dogfoodRoot, 'CATALOG.md');
    await writeFile(catalogPath, `${entries.join('\n')}\n`, 'utf8');
    return { catalogPath, dogfoodRoot };
  }

  it('passes when every listed bundle resolves to a real directory', async () => {
    const { catalogPath, dogfoodRoot } = await writeCatalogFixture(
      [
        '| `dogfood/scenario-one/` | First scenario |',
        '| `dogfood/scenario-two/` | Second scenario |',
      ],
      ['scenario-one', 'scenario-two'],
    );

    const result = await checkCatalogParity(catalogPath, dogfoodRoot);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing directories listed in the catalog', async () => {
    const { catalogPath, dogfoodRoot } = await writeCatalogFixture(
      [
        '| `dogfood/scenario-one/` | First scenario |',
        '| `dogfood/missing-scenario/` | Stale entry |',
      ],
      ['scenario-one'],
    );

    const result = await checkCatalogParity(catalogPath, dogfoodRoot);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['missing-scenario']);
  });

  it('skips glob-shaped historical entries that truncate at the asterisk', async () => {
    const { catalogPath, dogfoodRoot } = await writeCatalogFixture(
      [
        '| `dogfood/scenario-one/` | First scenario |',
        'Historical: `dogfood/20260319-*`, `dogfood/20260321-*`',
      ],
      ['scenario-one'],
    );

    const result = await checkCatalogParity(catalogPath, dogfoodRoot);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('deduplicates repeated bundle references', async () => {
    const { catalogPath, dogfoodRoot } = await writeCatalogFixture(
      [
        '| `dogfood/scenario-one/` | First scenario |',
        '`dogfood/scenario-one/foo` is also referenced',
      ],
      ['scenario-one'],
    );

    const result = await checkCatalogParity(catalogPath, dogfoodRoot);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
