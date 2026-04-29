import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const toolRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const NUMERIC_IDENTIFIER_PATTERN = /^(0|[1-9]\d*)$/u;
const RELEASE_IT_BIN = join(
  toolRoot,
  'node_modules',
  'release-it',
  'bin',
  'release-it.js',
);
const RELEASE_IT_CONFIG = join(toolRoot, '.release-it.json');

export function assertString(value, description) {
  assert.equal(typeof value, 'string', `${description} must be a string`);
  assert(value.length > 0, `${description} must not be empty`);
  return value;
}

export function parsePrepArgs(argv) {
  assert(Array.isArray(argv), 'argv must be an array');

  let version = null;
  let changelog = null;
  let verify = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = assertString(argv[index], 'CLI argument');

    if (argument === '--verify') {
      verify = true;
      continue;
    }

    if (argument === '--version' || argument.startsWith('--version=')) {
      assert(version === null, '--version may only be provided once');
      if (argument === '--version') {
        index += 1;
        assert(index < argv.length, '--version requires a value');
        version = assertString(argv[index], '--version value');
      } else {
        version = assertString(
          argument.slice('--version='.length),
          '--version value',
        );
      }
      continue;
    }

    if (argument === '--changelog' || argument.startsWith('--changelog=')) {
      assert(changelog === null, '--changelog may only be provided once');
      if (argument === '--changelog') {
        index += 1;
        assert(index < argv.length, '--changelog requires a value');
        changelog = assertString(argv[index], '--changelog value');
      } else {
        changelog = assertString(
          argument.slice('--changelog='.length),
          '--changelog value',
        );
      }
      continue;
    }

    throw new Error(`unsupported argument: ${argument}`);
  }

  if (version === null) {
    throw new Error('--version <exact-semver> is required');
  }
  if (changelog !== 'local' && changelog !== 'ci') {
    throw new Error('--changelog local|ci is required');
  }

  return { version, changelog, verify };
}

export function parseFinalizeArgs(argv) {
  assert(Array.isArray(argv), 'argv must be an array');

  let verify = false;
  for (const rawArgument of argv) {
    const argument = assertString(rawArgument, 'CLI argument');
    if (argument === '--verify') {
      verify = true;
      continue;
    }

    throw new Error(`unsupported argument: ${argument}`);
  }

  return { verify };
}

export function parseSemver(version) {
  assertString(version, 'version');
  if (version.includes('+')) {
    throw new Error(
      `version ${version} contains build metadata, which release automation does not support yet`,
    );
  }

  const match = SEMVER_PATTERN.exec(version);
  if (match === null) {
    throw new Error(`version ${version} is not an exact semantic version`);
  }

  const [, major, minor, patch, prerelease] = match;
  assert(major !== undefined, 'major version match missing');
  assert(minor !== undefined, 'minor version match missing');
  assert(patch !== undefined, 'patch version match missing');

  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  };
}

function compareIdentifiers(left, right) {
  assertString(left, 'left prerelease identifier');
  assertString(right, 'right prerelease identifier');

  const leftIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(left);
  const rightIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue === rightValue) {
      return 0;
    }
    return leftValue < rightValue ? -1 : 1;
  }

  if (leftIsNumeric !== rightIsNumeric) {
    return leftIsNumeric ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);

  for (const key of ['major', 'minor', 'patch']) {
    assert(key in left, `missing left ${key}`);
    assert(key in right, `missing right ${key}`);
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }

    const compared = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (compared !== 0) {
      return compared;
    }
  }

  return 0;
}

export function assertTargetVersionIsGreater(currentVersion, targetVersion) {
  parseSemver(currentVersion);
  parseSemver(targetVersion);

  const compared = compareSemver(currentVersion, targetVersion);
  if (compared === 0) {
    throw new Error(
      `target version ${targetVersion} matches current package version`,
    );
  }
  if (compared > 0) {
    throw new Error(
      `target version ${targetVersion} must be greater than current package version ${currentVersion}`,
    );
  }
}

function readJsonFile(path, description) {
  const raw = readFileSync(path, 'utf8');
  assert(raw.length > 0, `${description} must not be empty`);

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${description} is not valid JSON`, { cause: error });
  }
}

function assertPackageLike(value, description) {
  assert(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${description} must be an object`,
  );
  return value;
}

export function readPackageVersions(root = process.cwd()) {
  const resolvedRoot = resolve(root);
  const packageJson = assertPackageLike(
    readJsonFile(join(resolvedRoot, 'package.json'), 'package.json'),
    'package.json',
  );
  const packageLock = assertPackageLike(
    readJsonFile(join(resolvedRoot, 'package-lock.json'), 'package-lock.json'),
    'package-lock.json',
  );

  const packageVersion = assertString(
    packageJson.version,
    'package.json version',
  );
  const lockfileVersion = assertString(
    packageLock.version,
    'package-lock.json version',
  );
  const packages = assertPackageLike(
    packageLock.packages,
    'package-lock.json packages',
  );
  const rootPackage = assertPackageLike(
    packages[''],
    'package-lock.json packages[""]',
  );
  const lockRootVersion = assertString(
    rootPackage.version,
    'package-lock.json packages[""].version',
  );

  return {
    packageName: assertString(packageJson.name, 'package.json name'),
    packageVersion,
    lockfileVersion,
    lockRootVersion,
  };
}

export function assertPackageVersionsMatch(
  root = process.cwd(),
  expectedVersion = null,
) {
  assert(
    expectedVersion === null || typeof expectedVersion === 'string',
    'expected version must be a string or null',
  );
  const versions = readPackageVersions(root);
  assert.equal(
    versions.packageName,
    'agent-tty',
    'package.json name must be agent-tty',
  );
  assert.equal(
    versions.lockfileVersion,
    versions.packageVersion,
    'package-lock.json version must match package.json version',
  );
  assert.equal(
    versions.lockRootVersion,
    versions.packageVersion,
    'package-lock.json packages[""].version must match package.json version',
  );
  if (expectedVersion !== null) {
    assert.equal(
      versions.packageVersion,
      expectedVersion,
      'package.json version must match requested release version',
    );
  }

  return versions;
}

function formatCommand(command, args) {
  assertString(command, 'command');
  assert(Array.isArray(args), 'command args must be an array');
  return [command, ...args].join(' ');
}

export function run(command, args, options = {}) {
  assertString(command, 'command');
  assert(Array.isArray(args), 'command args must be an array');

  const {
    cwd = process.cwd(),
    env = process.env,
    expectedStatus = 0,
    stdio = 'pipe',
  } = options;
  assertString(cwd, 'cwd');
  assert(env !== null && typeof env === 'object', 'env must be an object');
  assert(
    Number.isInteger(expectedStatus),
    'expected status must be an integer',
  );
  assert(stdio === 'pipe' || stdio === 'inherit', 'unsupported stdio mode');

  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio,
  });

  if (result.error !== undefined) {
    throw new Error(`failed to start ${command}: ${result.error.message}`, {
      cause: result.error,
    });
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';

  if (result.status !== expectedStatus) {
    throw new Error(
      [
        `command failed: ${formatCommand(command, args)}`,
        `cwd: ${cwd}`,
        `expected exit code: ${String(expectedStatus)}`,
        `actual exit code: ${String(result.status)}`,
        stdout.length === 0 ? '' : `stdout:\n${stdout}`,
        stderr.length === 0 ? '' : `stderr:\n${stderr}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n\n'),
    );
  }

  return { stdout, stderr, status: result.status ?? 0 };
}

function tryRun(command, args, options = {}) {
  const { cwd = process.cwd(), env = process.env, stdio = 'pipe' } = options;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio,
  });

  return {
    error: result.error,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

export function runGit(root, args, options = {}) {
  return run('git', args, { ...options, cwd: root });
}

export function assertRepoRoot(root = process.cwd()) {
  const resolvedRoot = resolve(root);
  const topLevel = runGit(resolvedRoot, [
    'rev-parse',
    '--show-toplevel',
  ]).stdout.trim();
  assertString(topLevel, 'git top-level');
  assert.equal(
    resolve(topLevel),
    resolvedRoot,
    'release scripts must run at the repo root',
  );
  assertPackageVersionsMatch(resolvedRoot);
  return resolvedRoot;
}

export function assertCleanWorkingTree(root) {
  const status = runGit(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]).stdout.trim();
  if (status.length > 0) {
    throw new Error(
      `working tree must be clean before release automation:\n${status}`,
    );
  }
}

export function assertCurrentBranch(root, expectedBranch) {
  const branch = runGit(root, ['branch', '--show-current']).stdout.trim();
  if (branch !== expectedBranch) {
    throw new Error(
      `release automation must run from ${expectedBranch}; current branch is ${branch || '(detached HEAD)'}`,
    );
  }
}

export function fetchOriginMain(root) {
  runGit(root, [
    'fetch',
    '--no-tags',
    'origin',
    'main:refs/remotes/origin/main',
  ]);
}

export function assertHeadMatchesOriginMain(root) {
  const head = runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  const originMain = runGit(root, ['rev-parse', 'origin/main']).stdout.trim();
  assertString(head, 'HEAD revision');
  assertString(originMain, 'origin/main revision');
  if (head !== originMain) {
    throw new Error('local main must be up to date with origin/main');
  }
}

export function assertSyncedMain(root) {
  assertCurrentBranch(root, 'main');
  fetchOriginMain(root);
  assertHeadMatchesOriginMain(root);
}

export function assertGitIdentity(root, action) {
  assertString(action, 'git identity action');
  const userNameResult = tryRun('git', ['config', '--get', 'user.name'], {
    cwd: root,
  });
  const userEmailResult = tryRun('git', ['config', '--get', 'user.email'], {
    cwd: root,
  });
  const userName = userNameResult.stdout.trim();
  const userEmail = userEmailResult.stdout.trim();
  if (
    userNameResult.status !== 0 ||
    userEmailResult.status !== 0 ||
    userName.length === 0 ||
    userEmail.length === 0
  ) {
    throw new Error(
      `git user.name and user.email must be configured before ${action}`,
    );
  }
}

export function localBranchExists(root, branchName) {
  assertString(branchName, 'branch name');
  const result = tryRun(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
    { cwd: root },
  );
  if (result.error !== undefined) {
    throw new Error(
      `failed to inspect local branch ${branchName}: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  return result.status === 0;
}

export function remoteBranchExists(root, branchName) {
  assertString(branchName, 'branch name');
  const result = tryRun(
    'git',
    ['ls-remote', '--exit-code', '--heads', 'origin', branchName],
    { cwd: root },
  );
  if (result.error !== undefined) {
    throw new Error(
      `failed to inspect remote branch ${branchName}: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 2) {
    return false;
  }
  throw new Error(
    [
      `failed to inspect remote branch ${branchName}`,
      result.stdout.length === 0 ? '' : `stdout:\n${result.stdout}`,
      result.stderr.length === 0 ? '' : `stderr:\n${result.stderr}`,
    ]
      .filter((line) => line.length > 0)
      .join('\n\n'),
  );
}

export function localTagExists(root, tagName) {
  assertString(tagName, 'tag name');
  const result = tryRun(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/tags/${tagName}`],
    { cwd: root },
  );
  if (result.error !== undefined) {
    throw new Error(
      `failed to inspect local tag ${tagName}: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  return result.status === 0;
}

export function remoteTagExists(root, tagName) {
  assertString(tagName, 'tag name');
  const result = tryRun(
    'git',
    ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tagName}`],
    { cwd: root },
  );
  if (result.error !== undefined) {
    throw new Error(
      `failed to inspect remote tag ${tagName}: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 2) {
    return false;
  }
  throw new Error(
    [
      `failed to inspect remote tag ${tagName}`,
      result.stdout.length === 0 ? '' : `stdout:\n${result.stdout}`,
      result.stderr.length === 0 ? '' : `stderr:\n${result.stderr}`,
    ]
      .filter((line) => line.length > 0)
      .join('\n\n'),
  );
}

export function assertReleaseBranchAvailable(root, version) {
  const branchName = `release/${version}`;
  if (localBranchExists(root, branchName)) {
    throw new Error(`local release branch already exists: ${branchName}`);
  }
  if (remoteBranchExists(root, branchName)) {
    throw new Error(
      `remote release branch already exists: origin/${branchName}`,
    );
  }
  return branchName;
}

export function assertReleaseTagAvailable(root, version) {
  const tagName = `v${version}`;
  if (localTagExists(root, tagName)) {
    throw new Error(`local release tag already exists: ${tagName}`);
  }
  if (remoteTagExists(root, tagName)) {
    throw new Error(`remote release tag already exists: origin/${tagName}`);
  }
  return tagName;
}

export function getChangedFiles(root) {
  const status = runGit(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]).stdout;
  const files = new Set();

  for (const line of status.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    assert(line.length >= 4, `unexpected git status line: ${line}`);
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) {
      const [, destination] = file.split(' -> ');
      file = assertString(destination, 'renamed destination');
    }
    files.add(file);
  }

  return [...files].sort();
}

export function assertAllowedChangedFiles(root, allowedFiles) {
  assert(Array.isArray(allowedFiles), 'allowed files must be an array');
  const allowed = new Set(
    allowedFiles.map((file) => assertString(file, 'allowed changed file')),
  );
  const changedFiles = getChangedFiles(root);
  const unexpectedFiles = changedFiles.filter((file) => !allowed.has(file));
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `release automation produced unexpected file changes: ${unexpectedFiles.join(', ')}`,
    );
  }
  return changedFiles;
}

export function assertExpectedFilesChanged(changedFiles, expectedFiles) {
  assert(Array.isArray(changedFiles), 'changed files must be an array');
  assert(Array.isArray(expectedFiles), 'expected files must be an array');
  const changed = new Set(changedFiles);
  const missingFiles = expectedFiles.filter((file) => !changed.has(file));
  if (missingFiles.length > 0) {
    throw new Error(
      `release automation did not change expected files: ${missingFiles.join(', ')}`,
    );
  }
}

export function stageFiles(root, files) {
  assert(Array.isArray(files), 'files must be an array');
  runGit(root, ['add', '--', ...files]);
}

export function createCommit(root, message) {
  assertString(message, 'commit message');
  runGit(root, ['commit', '-m', message], { stdio: 'inherit' });
}

export function assertExactlyOneCommitSince(root, baseRevision) {
  assertString(baseRevision, 'base revision');
  const rawCount = runGit(root, [
    'rev-list',
    '--count',
    `${baseRevision}..HEAD`,
  ]).stdout.trim();
  const commitCount = Number.parseInt(rawCount, 10);
  assert(Number.isInteger(commitCount), 'commit count must be an integer');
  assert.equal(commitCount, 1, 'release prep must create exactly one commit');
}

function pathEntries(env) {
  assert(env !== null && typeof env === 'object', 'env must be an object');
  const rawPath = typeof env.PATH === 'string' ? env.PATH : '';
  return rawPath.split(delimiter).filter((entry) => entry.length > 0);
}

export function findExecutable(name, env = process.env) {
  assertString(name, 'executable name');
  const extensions =
    process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of pathEntries(env)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

export function commandIsAvailable(name, env = process.env) {
  return findExecutable(name, env) !== null;
}

function hasEnv(env, name) {
  assert(env !== null && typeof env === 'object', 'env must be an object');
  assertString(name, 'env name');
  const value = env[name];
  return typeof value === 'string' && value.length > 0;
}

export function assertLocalChangelogPrerequisites(
  root,
  version,
  env = process.env,
) {
  assertString(root, 'root');
  assertString(version, 'version');

  const missing = [];
  const hasAnthropicKey = hasEnv(env, 'ANTHROPIC_API_KEY');
  const hasOpenAiKey = hasEnv(env, 'OPENAI_API_KEY');
  if (!hasAnthropicKey && !hasOpenAiKey) {
    missing.push('ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }
  if (!hasAnthropicKey && hasOpenAiKey && !hasEnv(env, 'COMMUNIQUE_MODEL')) {
    missing.push(
      'COMMUNIQUE_MODEL when using OPENAI_API_KEY without ANTHROPIC_API_KEY',
    );
  }
  if (!commandIsAvailable('communique', env)) {
    missing.push('communique on PATH');
  }
  if (!hasEnv(env, 'GITHUB_TOKEN')) {
    if (!commandIsAvailable('gh', env)) {
      missing.push('GITHUB_TOKEN or an authenticated gh CLI session');
    } else {
      const ghResult = tryRun(
        'gh',
        ['api', 'graphql', '-f', 'query=query { viewer { login } }'],
        { cwd: root, env },
      );
      if (ghResult.status !== 0) {
        missing.push('GITHUB_TOKEN or an authenticated gh CLI session');
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      [
        'local changelog prerequisites are missing:',
        ...missing.map((item) => `- ${item}`),
        `Fallback: npm run release:prep -- --version ${version} --changelog ci`,
      ].join('\n'),
    );
  }
}

export function runReleaseIt(root, version, env = process.env) {
  assertString(root, 'root');
  assertString(version, 'version');
  if (!existsSync(RELEASE_IT_BIN)) {
    throw new Error(
      `release-it binary is missing at ${RELEASE_IT_BIN}; run npm install first`,
    );
  }
  if (!existsSync(RELEASE_IT_CONFIG)) {
    throw new Error(`release-it config is missing at ${RELEASE_IT_CONFIG}`);
  }

  run(
    process.execPath,
    [RELEASE_IT_BIN, version, '--ci', '--config', RELEASE_IT_CONFIG],
    {
      cwd: root,
      env: { ...env, CI: 'true' },
      stdio: 'inherit',
    },
  );
}

export function runCommunique(root, version, env = process.env) {
  assertString(root, 'root');
  assertString(version, 'version');
  run(
    'communique',
    ['generate', `v${version}`, '--changelog', '--repo', 'coder/agent-tty'],
    { cwd: root, env, stdio: 'inherit' },
  );
}

function runNpm(root, args, env = process.env) {
  assert(Array.isArray(args), 'npm args must be an array');
  const npmExecPath = env.npm_execpath;
  if (typeof npmExecPath === 'string' && npmExecPath.length > 0) {
    run(process.execPath, [npmExecPath, ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    return;
  }

  run('npm', args, { cwd: root, env, stdio: 'inherit' });
}

export function runVerification(root, env = process.env) {
  if (commandIsAvailable('mise', env)) {
    run('mise', ['run', 'ci'], { cwd: root, env, stdio: 'inherit' });
    return;
  }

  runNpm(root, ['run', 'verify'], env);
}

export function exitWithError(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
