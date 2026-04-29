import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
