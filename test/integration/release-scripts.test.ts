import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const releasePrepScript = resolve('scripts/release-prep.mjs');
const releaseFinalizeScript = resolve('scripts/release-finalize.mjs');

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface TempRepo {
  root: string;
  origin: string;
  repo: string;
}

const tempRoots: string[] = [];

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    expectedStatus?: number;
  } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });

  expect(result.error).toBeUndefined();
  const status = result.status ?? 1;
  const commandResult = {
    status,
    stdout: result.stdout,
    stderr: result.stderr,
  };

  if (options.expectedStatus !== undefined) {
    expect(commandResult).toMatchObject({ status: options.expectedStatus });
  }

  return commandResult;
}

function runGit(repo: string, args: string[]): string {
  return run('git', args, { cwd: repo, expectedStatus: 0 }).stdout.trim();
}

function writePackageFiles(repo: string, version: string): void {
  const packageJson = {
    name: 'agent-tty',
    version,
    type: 'module',
    private: true,
  };
  const packageLock = {
    name: 'agent-tty',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'agent-tty',
        version,
        license: 'Apache-2.0',
      },
    },
  };

  writeFileSync(join(repo, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  writeFileSync(
    join(repo, 'package-lock.json'),
    `${JSON.stringify(packageLock)}\n`,
  );
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n');
}

function createTempRepo(version = '0.1.1-beta.4'): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'agent-tty-release-scripts-'));
  tempRoots.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');

  run('git', ['init', '-q', '--bare', origin], { expectedStatus: 0 });
  run('git', ['init', '-q', '-b', 'main', repo], { expectedStatus: 0 });
  runGit(repo, ['remote', 'add', 'origin', origin]);
  runGit(repo, ['config', 'user.name', 'Agent TTY Test']);
  runGit(repo, ['config', 'user.email', 'agent-tty-test@example.invalid']);
  writePackageFiles(repo, version);
  runGit(repo, ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
  runGit(repo, ['commit', '-q', '-m', 'init']);
  runGit(repo, ['push', '-q', '-u', 'origin', 'main']);

  return { root, origin, repo };
}

function runReleasePrep(
  repo: string,
  args: string[],
  env = process.env,
): CommandResult {
  return run(process.execPath, [releasePrepScript, ...args], {
    cwd: repo,
    env,
  });
}

function runReleaseFinalize(
  repo: string,
  args: string[] = [],
  env = process.env,
): CommandResult {
  return run(process.execPath, [releaseFinalizeScript, ...args], {
    cwd: repo,
    env,
  });
}

function readVersions(repo: string): [string, string, string] {
  const packageJson = JSON.parse(
    readFileSync(join(repo, 'package.json'), 'utf8'),
  ) as { version: string };
  const packageLock = JSON.parse(
    readFileSync(join(repo, 'package-lock.json'), 'utf8'),
  ) as { version: string; packages: { '': { version: string } } };

  return [
    packageJson.version,
    packageLock.version,
    packageLock.packages[''].version,
  ];
}

function withoutLocalChangelogCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GITHUB_TOKEN;
  return env;
}

function withFakeMise(root: string): {
  env: NodeJS.ProcessEnv;
  marker: string;
} {
  const bin = join(root, 'bin');
  const marker = join(root, 'mise-called.txt');
  mkdirSync(bin);
  const misePath = join(bin, 'mise');
  writeFileSync(
    misePath,
    [
      '#!/usr/bin/env sh',
      `printf '%s\n' "$*" >> '${marker}'`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(misePath, 0o755);

  return {
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    },
    marker,
  };
}

describe('release scripts', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('prepares a ci-changelog release branch with one version commit', () => {
    const { repo } = createTempRepo();

    const result = runReleasePrep(repo, [
      '--version',
      '0.1.1-beta.5',
      '--changelog',
      'ci',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'Release prep commit created on release/0.1.1-beta.5.',
    );
    expect(result.stdout).toContain('git push -u origin release/0.1.1-beta.5');
    expect(runGit(repo, ['branch', '--show-current'])).toBe(
      'release/0.1.1-beta.5',
    );
    expect(runGit(repo, ['status', '--short'])).toBe('');
    expect(runGit(repo, ['rev-list', '--count', 'origin/main..HEAD'])).toBe(
      '1',
    );
    expect(runGit(repo, ['show', '-s', '--format=%s', 'HEAD'])).toBe(
      'chore(release): 0.1.1-beta.5',
    );
    expect(
      runGit(repo, ['diff', '--name-only', 'HEAD^..HEAD']).split('\n'),
    ).toEqual(['package-lock.json', 'package.json']);
    expect(readVersions(repo)).toEqual([
      '0.1.1-beta.5',
      '0.1.1-beta.5',
      '0.1.1-beta.5',
    ]);
  });

  it('fails local changelog prep before creating a branch when credentials are missing', () => {
    const { repo } = createTempRepo();

    const result = runReleasePrep(
      repo,
      ['--version', '0.1.1-beta.5', '--changelog', 'local'],
      withoutLocalChangelogCredentials(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'local changelog prerequisites are missing',
    );
    expect(result.stderr).toContain(
      'Fallback: npm run release:prep -- --version 0.1.1-beta.5 --changelog ci',
    );
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['status', '--short'])).toBe('');
  });

  it('refuses to prepare a release from a dirty tree', () => {
    const { repo } = createTempRepo();
    writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\nDirty work\n');

    const result = runReleasePrep(repo, [
      '--version',
      '0.1.1-beta.5',
      '--changelog',
      'ci',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('working tree must be clean');
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
  });

  it('refuses to prepare a release from a non-main branch', () => {
    const { repo } = createTempRepo();
    runGit(repo, ['switch', '-c', 'feature/not-main']);

    const result = runReleasePrep(repo, [
      '--version',
      '0.1.1-beta.5',
      '--changelog',
      'ci',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release automation must run from main');
    expect(runGit(repo, ['branch', '--show-current'])).toBe('feature/not-main');
  });

  it('refuses to prepare a release when local main is stale', () => {
    const { repo } = createTempRepo();
    writeFileSync(join(repo, 'remote-only.txt'), 'remote change\n');
    runGit(repo, ['add', 'remote-only.txt']);
    runGit(repo, ['commit', '-q', '-m', 'advance remote']);
    runGit(repo, ['push', '-q', 'origin', 'main']);
    runGit(repo, ['reset', '--hard', 'HEAD~1']);

    const result = runReleasePrep(repo, [
      '--version',
      '0.1.1-beta.5',
      '--changelog',
      'ci',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'local main must be up to date with origin/main',
    );
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
  });

  it('refuses to prepare a release when the local release branch already exists', () => {
    const { repo } = createTempRepo();
    runGit(repo, ['branch', 'release/0.1.1-beta.5']);

    const result = runReleasePrep(repo, [
      '--version',
      '0.1.1-beta.5',
      '--changelog',
      'ci',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'local release branch already exists: release/0.1.1-beta.5',
    );
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
  });

  it('refuses to prepare a release when the remote release branch already exists', () => {
    const { repo } = createTempRepo();
    runGit(repo, ['branch', 'release/0.1.1-beta.5']);
    runGit(repo, ['push', '-q', 'origin', 'release/0.1.1-beta.5']);
    runGit(repo, ['branch', '-D', 'release/0.1.1-beta.5']);

    const result = runReleasePrep(repo, [
      '--version',
      '0.1.1-beta.5',
      '--changelog',
      'ci',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'remote release branch already exists: origin/release/0.1.1-beta.5',
    );
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
  });

  it('refuses same or lower release prep target versions', () => {
    const sameVersionRepo = createTempRepo();
    const sameResult = runReleasePrep(sameVersionRepo.repo, [
      '--version',
      '0.1.1-beta.4',
      '--changelog',
      'ci',
    ]);

    expect(sameResult.status).toBe(1);
    expect(sameResult.stderr).toContain(
      'target version 0.1.1-beta.4 matches current package version',
    );
    expect(runGit(sameVersionRepo.repo, ['branch', '--show-current'])).toBe(
      'main',
    );

    const lowerVersionRepo = createTempRepo();
    const lowerResult = runReleasePrep(lowerVersionRepo.repo, [
      '--version',
      '0.1.1-beta.3',
      '--changelog',
      'ci',
    ]);

    expect(lowerResult.status).toBe(1);
    expect(lowerResult.stderr).toContain(
      'target version 0.1.1-beta.3 must be greater than current package version 0.1.1-beta.4',
    );
    expect(runGit(lowerVersionRepo.repo, ['branch', '--show-current'])).toBe(
      'main',
    );
  });

  it('handles semver prerelease edge precedence before release prep side effects', () => {
    const alphaRepo = createTempRepo('1.0.0-alpha.1');
    const alphaResult = runReleasePrep(alphaRepo.repo, [
      '--version',
      '1.0.0-alpha',
      '--changelog',
      'ci',
    ]);

    expect(alphaResult.status).toBe(1);
    expect(alphaResult.stderr).toContain(
      'target version 1.0.0-alpha must be greater than current package version 1.0.0-alpha.1',
    );
    expect(runGit(alphaRepo.repo, ['branch', '--show-current'])).toBe('main');

    const numericRepo = createTempRepo('1.0.0-alpha.10');
    const numericResult = runReleasePrep(numericRepo.repo, [
      '--version',
      '1.0.0-alpha.2',
      '--changelog',
      'ci',
    ]);

    expect(numericResult.status).toBe(1);
    expect(numericResult.stderr).toContain(
      'target version 1.0.0-alpha.2 must be greater than current package version 1.0.0-alpha.10',
    );
    expect(runGit(numericRepo.repo, ['branch', '--show-current'])).toBe('main');

    const stableRepo = createTempRepo('1.0.0');
    const stableResult = runReleasePrep(stableRepo.repo, [
      '--version',
      '1.0.0-rc.1',
      '--changelog',
      'ci',
    ]);

    expect(stableResult.status).toBe(1);
    expect(stableResult.stderr).toContain(
      'target version 1.0.0-rc.1 must be greater than current package version 1.0.0',
    );
    expect(runGit(stableRepo.repo, ['branch', '--show-current'])).toBe('main');

    const buildMetadataRepo = createTempRepo();
    const buildMetadataResult = runReleasePrep(buildMetadataRepo.repo, [
      '--version',
      '0.1.1-beta.5+build.1',
      '--changelog',
      'ci',
    ]);

    expect(buildMetadataResult.status).toBe(1);
    expect(buildMetadataResult.stderr).toContain('contains build metadata');
    expect(runGit(buildMetadataRepo.repo, ['branch', '--show-current'])).toBe(
      'main',
    );
  });

  it('runs verification during release prep when requested', () => {
    const { root, repo } = createTempRepo();
    const { env, marker } = withFakeMise(root);

    const result = runReleasePrep(
      repo,
      ['--version', '0.1.1-beta.5', '--changelog', 'ci', '--verify'],
      env,
    );

    expect(result.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('run ci\n');
    expect(runGit(repo, ['status', '--short'])).toBe('');
  });

  it('finalizes by creating and pushing the exact release tag', () => {
    const { repo } = createTempRepo('0.1.1-beta.5');

    const result = runReleaseFinalize(repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release tag v0.1.1-beta.5 pushed.');
    expect(runGit(repo, ['tag', '--list'])).toBe('v0.1.1-beta.5');
    expect(
      runGit(repo, [
        'ls-remote',
        '--tags',
        'origin',
        'refs/tags/v0.1.1-beta.5',
      ]),
    ).toContain('refs/tags/v0.1.1-beta.5');
  });

  it('refuses to finalize from a dirty tree', () => {
    const { repo } = createTempRepo('0.1.1-beta.5');
    writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\nDirty work\n');

    const result = runReleaseFinalize(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('working tree must be clean');
    expect(runGit(repo, ['tag', '--list'])).toBe('');
  });

  it('refuses to finalize from a non-main branch', () => {
    const { repo } = createTempRepo('0.1.1-beta.5');
    runGit(repo, ['switch', '-c', 'feature/not-main']);

    const result = runReleaseFinalize(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release automation must run from main');
    expect(runGit(repo, ['tag', '--list'])).toBe('');
  });

  it('refuses to finalize when the local release tag already exists', () => {
    const { repo } = createTempRepo('0.1.1-beta.5');
    runGit(repo, ['tag', '-a', 'v0.1.1-beta.5', '-m', 'v0.1.1-beta.5']);

    const result = runReleaseFinalize(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'local release tag already exists: v0.1.1-beta.5',
    );
    expect(runGit(repo, ['ls-remote', '--tags', 'origin'])).toBe('');
  });

  it('runs verification during release finalization when requested', () => {
    const { root, repo } = createTempRepo('0.1.1-beta.5');
    const { env, marker } = withFakeMise(root);

    const result = runReleaseFinalize(repo, ['--verify'], env);

    expect(result.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('run ci\n');
    expect(runGit(repo, ['tag', '--list'])).toBe('v0.1.1-beta.5');
  });

  it('refuses to finalize when the remote release tag already exists', () => {
    const { repo } = createTempRepo('0.1.1-beta.5');
    runGit(repo, ['tag', '-a', 'v0.1.1-beta.5', '-m', 'v0.1.1-beta.5']);
    runGit(repo, ['push', '-q', 'origin', 'v0.1.1-beta.5']);
    runGit(repo, ['tag', '-d', 'v0.1.1-beta.5']);

    const result = runReleaseFinalize(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'remote release tag already exists: origin/v0.1.1-beta.5',
    );
    expect(runGit(repo, ['tag', '--list'])).toBe('');
  });
});
