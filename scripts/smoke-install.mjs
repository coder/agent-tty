#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCliPath = process.env.npm_execpath;
const supportedArgs = new Set(['--skip-build']);

for (const argument of process.argv.slice(2)) {
  assert(supportedArgs.has(argument), `unsupported argument: ${argument}`);
}

const skipBuild = process.argv.includes('--skip-build');

const packageJson = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
);
const packageName = packageJson.name;
const packageVersion = packageJson.version;
const packageBins = packageJson.bin;

assert.equal(
  typeof packageName,
  'string',
  'package.json name must be a string',
);
assert.equal(
  typeof packageVersion,
  'string',
  'package.json version must be a string',
);
assert(
  typeof packageBins === 'object' && packageBins !== null,
  'package.json bin must be an object',
);

const [binName] = Object.keys(packageBins);
assert(typeof binName === 'string' && binName.length > 0, 'bin name missing');

const tempRoot = await mkdtemp(join(tmpdir(), 'agent-terminal-install-smoke-'));

function logStep(message) {
  assert(message.length > 0, 'log messages must be non-empty');
  process.stdout.write(`${message}\n`);
}

// Some dev environments inject `mise activate` into npm build subprocesses.
// Trust the current repo plus temp roots so packaging smoke reflects the
// package behavior instead of unrelated local shell trust prompts.
function getTrustedConfigPaths() {
  const trustedPaths = new Set();
  const existingPaths = process.env.MISE_TRUSTED_CONFIG_PATHS;

  if (typeof existingPaths === 'string' && existingPaths.length > 0) {
    for (const trustedPath of existingPaths.split(delimiter)) {
      if (trustedPath.length > 0) {
        trustedPaths.add(trustedPath);
      }
    }
  }

  const npmCachePath =
    process.env.npm_config_cache ?? join(process.env.HOME ?? homedir(), '.npm');
  trustedPaths.add(npmCachePath);
  trustedPaths.add(projectRoot);
  trustedPaths.add(tempRoot);
  trustedPaths.add(tmpdir());
  return [...trustedPaths].join(delimiter);
}

function sanitizeInheritedPath(pathValue) {
  assert(typeof pathValue === 'string', 'PATH must be a string');
  assert(pathValue.length > 0, 'PATH must not be empty');

  const sanitizedEntries = pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .filter(
      (entry) =>
        !entry.endsWith(`${join('node_modules', '.bin')}`) &&
        !entry.endsWith('node-gyp-bin'),
    );

  assert(
    sanitizedEntries.length > 0,
    'sanitized PATH must retain at least one executable directory',
  );
  return sanitizedEntries.join(delimiter);
}

function getDefaultEnv() {
  return {
    ...process.env,
    PATH: sanitizeInheritedPath(process.env.PATH ?? ''),
    MISE_TRUSTED_CONFIG_PATHS: getTrustedConfigPaths(),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function run(command, args, options = {}) {
  const {
    cwd = projectRoot,
    env = getDefaultEnv(),
    expectedStatus = 0,
    allowFailure = false,
  } = options;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
  });

  assert(result.error === undefined, result.error?.message ?? 'spawn failed');
  if (!allowFailure) {
    assert.equal(
      result.status,
      expectedStatus,
      [
        `command failed: ${formatCommand(command, args)}`,
        `cwd: ${cwd}`,
        `expected exit code: ${String(expectedStatus)}`,
        `actual exit code: ${String(result.status)}`,
        result.stdout.length === 0 ? '' : `stdout:\n${result.stdout}`,
        result.stderr.length === 0 ? '' : `stderr:\n${result.stderr}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n\n'),
    );
  }

  return result;
}

function runNpm(args, options = {}) {
  if (typeof npmCliPath === 'string' && npmCliPath.length > 0) {
    return run(process.execPath, [npmCliPath, ...args], options);
  }

  return run('npm', args, options);
}

function isKnownGitInstallCaveat(result) {
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  return (
    combinedOutput.includes('node-pty') &&
    (combinedOutput.includes('TAR_ENTRY_ERROR') ||
      combinedOutput.includes('spawn sh ENOENT') ||
      combinedOutput.includes('spawn /bin/sh ENOENT') ||
      combinedOutput.includes('uv_cwd') ||
      combinedOutput.includes('git dep preparation failed'))
  );
}

function parseJsonOutput(stdout, description) {
  assert(stdout.trim().length > 0, `${description} must not be empty`);

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${description} was not valid JSON`, { cause: error });
  }
}

async function listRelativeFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(absolutePath, root)));
      continue;
    }

    assert(entry.isFile(), `expected file entry under ${directory}`);
    files.push(relative(root, absolutePath).replaceAll('\\', '/'));
  }

  return files.sort();
}

async function assertPathExists(path, description, mode = fsConstants.F_OK) {
  await access(path, mode).catch((error) => {
    throw new Error(`${description} missing at ${path}`, { cause: error });
  });
}

async function assertPackagePaths(packageRoot, requiredPaths, label) {
  for (const requiredPath of requiredPaths) {
    await assertPathExists(
      join(packageRoot, requiredPath),
      `${label} package path ${requiredPath}`,
    );
  }
}

function getRequiredPackPaths(rendererAssets) {
  return [
    'dist/cli/main.js',
    'dist/index.js',
    'dist/index.d.ts',
    'skills/agent-terminal/SKILL.md',
    ...rendererAssets.map(
      (assetPath) => `dist/renderer/ghosttyWeb/assets/${assetPath}`,
    ),
  ];
}

function assertPackedFiles(packMetadata, requiredPaths, label) {
  assert(
    Array.isArray(packMetadata.files),
    `${label} pack metadata must include files`,
  );
  const packedPaths = new Set(
    packMetadata.files.map((entry) => {
      assert(
        typeof entry === 'object' && entry !== null,
        `${label} pack entry must be an object`,
      );
      const path = entry.path;
      assert.equal(typeof path, 'string', 'pack entry path must be a string');
      return path;
    }),
  );

  for (const requiredPath of requiredPaths) {
    assert(
      packedPaths.has(requiredPath),
      `${label} pack is missing ${requiredPath}`,
    );
  }
}

async function resolveInstalledPackageRoot(prefix) {
  const npmRootResult = runNpm(['root', '-g', '--prefix', prefix]);
  const npmRoot = npmRootResult.stdout.trim();
  assert(npmRoot.length > 0, 'npm root output must not be empty');
  const packageRoot = join(npmRoot, packageName);
  await assertPathExists(packageRoot, 'installed package root');
  return packageRoot;
}

async function verifyInstalledCli(routeLabel, prefix) {
  const packageRoot = await resolveInstalledPackageRoot(prefix);
  const installedPackageJson = parseJsonOutput(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
    `${routeLabel} installed package.json`,
  );
  assert(
    typeof installedPackageJson === 'object' && installedPackageJson !== null,
    `${routeLabel} installed package.json must be an object`,
  );
  assert.equal(
    installedPackageJson.version,
    packageVersion,
    `${routeLabel} installed package version mismatch`,
  );

  const rendererAssets = await listRelativeFiles(
    join(projectRoot, 'src/renderer/ghosttyWeb/assets'),
  );
  const requiredPaths = getRequiredPackPaths(rendererAssets);
  await assertPackagePaths(packageRoot, requiredPaths, routeLabel);

  const binPath = join(
    prefix,
    'bin',
    process.platform === 'win32' ? `${binName}.cmd` : binName,
  );
  await assertPathExists(
    binPath,
    `${routeLabel} installed binary`,
    fsConstants.X_OK,
  );

  const versionResult = run(binPath, ['version', '--json']);
  const versionEnvelope = parseJsonOutput(
    versionResult.stdout,
    `${routeLabel} version output`,
  );
  assert(
    typeof versionEnvelope === 'object' && versionEnvelope !== null,
    `${routeLabel} version output must be an object`,
  );
  assert.equal(versionEnvelope.ok, true, `${routeLabel} version must succeed`);
  assert.equal(
    versionEnvelope.command,
    'version',
    `${routeLabel} version command mismatch`,
  );
  assert(
    typeof versionEnvelope.result === 'object' &&
      versionEnvelope.result !== null,
    `${routeLabel} version result must be an object`,
  );
  assert.equal(
    versionEnvelope.result.cliVersion,
    packageVersion,
    `${routeLabel} CLI version mismatch`,
  );

  const home = await mkdtemp(
    join(tempRoot, `${routeLabel.toLowerCase()}-home-`),
  );
  const doctorResult = run(binPath, ['--home', home, 'doctor', '--json']);
  const doctorEnvelope = parseJsonOutput(
    doctorResult.stdout,
    `${routeLabel} doctor output`,
  );
  assert(
    typeof doctorEnvelope === 'object' && doctorEnvelope !== null,
    `${routeLabel} doctor output must be an object`,
  );
  assert.equal(
    doctorEnvelope.ok,
    true,
    `${routeLabel} doctor must emit success envelope`,
  );
  assert.equal(
    doctorEnvelope.command,
    'doctor',
    `${routeLabel} doctor command mismatch`,
  );
  assert(
    typeof doctorEnvelope.result === 'object' && doctorEnvelope.result !== null,
    `${routeLabel} doctor result must be an object`,
  );
  assert.equal(
    doctorEnvelope.result.ok,
    true,
    `${routeLabel} doctor result must pass`,
  );
}

function shouldCopyPath(sourcePath) {
  const relativePath = relative(projectRoot, sourcePath);
  if (relativePath.length === 0) {
    return true;
  }

  const normalizedRelativePath = relativePath.replaceAll('\\', '/');
  if (
    normalizedRelativePath === 'dogfood/install-flows' ||
    normalizedRelativePath.startsWith('dogfood/install-flows/')
  ) {
    return false;
  }

  const pathParts = relativePath.split(/[/\\]+/);
  const fileName = basename(sourcePath);
  if (
    pathParts.includes('.git') ||
    pathParts.includes('node_modules') ||
    pathParts.includes('dist') ||
    pathParts.includes('coverage')
  ) {
    return false;
  }

  return !(
    fileName.endsWith('.tsbuildinfo') ||
    fileName.endsWith('.tgz') ||
    fileName === '.DS_Store'
  );
}

async function createGitInstallSource() {
  const gitSourceRoot = join(tempRoot, 'git-source');
  await cp(projectRoot, gitSourceRoot, {
    recursive: true,
    filter: shouldCopyPath,
  });

  run('git', ['init', '--quiet'], { cwd: gitSourceRoot });
  run('git', ['config', 'user.email', 'agent-terminal@example.invalid'], {
    cwd: gitSourceRoot,
  });
  run('git', ['config', 'user.name', 'agent-terminal smoke'], {
    cwd: gitSourceRoot,
  });
  run('git', ['add', '--all'], { cwd: gitSourceRoot });
  run('git', ['commit', '--quiet', '--message', 'package smoke'], {
    cwd: gitSourceRoot,
  });

  const revisionResult = run('git', ['rev-parse', 'HEAD'], {
    cwd: gitSourceRoot,
  });
  const revision = revisionResult.stdout.trim();
  assert(revision.length > 0, 'git source revision must not be empty');

  return {
    gitSourceRoot,
    gitUrl: `git+${pathToFileURL(gitSourceRoot).href}#${revision}`,
  };
}

try {
  const rendererAssets = await listRelativeFiles(
    join(projectRoot, 'src/renderer/ghosttyWeb/assets'),
  );
  const requiredPaths = getRequiredPackPaths(rendererAssets);

  if (!skipBuild) {
    logStep('Building package contents for tarball smoke...');
    runNpm(['run', 'build']);
  }

  logStep('Packing private tarball from built workspace...');
  const tarballDirectory = join(tempRoot, 'tarball');
  const tarballInstallPrefix = join(tempRoot, 'tarball-prefix');
  await mkdir(tarballDirectory, { recursive: true });
  const packResult = runNpm([
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    tarballDirectory,
  ]);
  const packMetadata = parseJsonOutput(packResult.stdout, 'npm pack output');
  assert(Array.isArray(packMetadata), 'npm pack output must be an array');
  assert.equal(
    packMetadata.length,
    1,
    'npm pack output must contain one entry',
  );
  const [packEntry] = packMetadata;
  assert(
    typeof packEntry === 'object' && packEntry !== null,
    'npm pack entry must be an object',
  );
  assert.equal(packEntry.name, packageName, 'packed package name mismatch');
  assert.equal(
    packEntry.version,
    packageVersion,
    'packed package version mismatch',
  );
  assertPackedFiles(packEntry, requiredPaths, 'tarball');

  const tarballFilename = packEntry.filename;
  assert.equal(
    typeof tarballFilename,
    'string',
    'packed tarball filename missing',
  );
  const tarballPath = join(tarballDirectory, tarballFilename);
  const tarballStats = await stat(tarballPath);
  assert(tarballStats.size > 0, 'packed tarball must not be empty');

  logStep('Installing built tarball into isolated prefix...');
  runNpm(['install', '-g', '--prefix', tarballInstallPrefix, tarballPath]);
  await verifyInstalledCli('Tarball', tarballInstallPrefix);

  logStep(
    'Preparing clean git source to exercise npm prepare for git installs...',
  );
  const gitInstallPrefix = join(tempRoot, 'git-prefix');
  const { gitUrl } = await createGitInstallSource();

  logStep('Installing from git dependency URL into isolated prefix...');
  const gitInstallResult = runNpm(
    ['install', '-g', '--prefix', gitInstallPrefix, gitUrl],
    { allowFailure: true },
  );

  if (gitInstallResult.status === 0) {
    await verifyInstalledCli('Git', gitInstallPrefix);
    logStep('Git dependency install route succeeded.');
  } else {
    assert(
      isKnownGitInstallCaveat(gitInstallResult),
      [
        'git dependency install failed in an unexpected way',
        gitInstallResult.stdout.length === 0
          ? ''
          : `stdout:\n${gitInstallResult.stdout}`,
        gitInstallResult.stderr.length === 0
          ? ''
          : `stderr:\n${gitInstallResult.stderr}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n\n'),
    );
    logStep(
      'Git dependency install matched the known caveat path; tarball fallback remains the guaranteed route.',
    );
  }

  logStep(
    'Packaging smoke passed: tarball route succeeded, and the current git-install behavior was validated.',
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
