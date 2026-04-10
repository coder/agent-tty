#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCliPath = process.env.npm_execpath;
const currentScriptPath = fileURLToPath(import.meta.url);
const invokedScriptPath =
  typeof process.argv[1] === 'string' ? resolve(process.argv[1]) : null;

function sanitizeInheritedPath(pathValue) {
  assert.equal(typeof pathValue, 'string', 'PATH must be a string');
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

function getTrustedConfigPaths(baseEnv, extraPaths) {
  assert(
    baseEnv !== null && typeof baseEnv === 'object',
    'env must be an object',
  );
  assert(Array.isArray(extraPaths), 'extra paths must be an array');

  const trustedPaths = new Set();
  const existingPaths = baseEnv.MISE_TRUSTED_CONFIG_PATHS;
  if (typeof existingPaths === 'string' && existingPaths.length > 0) {
    for (const trustedPath of existingPaths.split(delimiter)) {
      if (trustedPath.length > 0) {
        trustedPaths.add(trustedPath);
      }
    }
  }

  const npmCachePath =
    baseEnv.npm_config_cache ?? join(baseEnv.HOME ?? homedir(), '.npm');
  trustedPaths.add(npmCachePath);
  trustedPaths.add(projectRoot);
  trustedPaths.add(tmpdir());

  for (const extraPath of extraPaths) {
    if (typeof extraPath === 'string' && extraPath.length > 0) {
      trustedPaths.add(extraPath);
    }
  }

  return [...trustedPaths].join(delimiter);
}

function getDefaultEnv(extraPaths, baseEnv = process.env) {
  return {
    ...baseEnv,
    PATH: sanitizeInheritedPath(baseEnv.PATH ?? ''),
    MISE_TRUSTED_CONFIG_PATHS: getTrustedConfigPaths(baseEnv, extraPaths),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function relayOutput(target, content) {
  assert(target === 'stdout' || target === 'stderr', 'invalid relay target');
  assert.equal(typeof content, 'string', 'relayed output must be a string');
  if (content.length === 0) {
    return;
  }

  if (target === 'stdout') {
    process.stdout.write(content);
    return;
  }

  process.stderr.write(content);
}

function run(command, args, options = {}) {
  const {
    cwd = projectRoot,
    env,
    expectedStatus = 0,
    relayStdoutTo = null,
    relayStderrTo = null,
  } = options;
  assert(typeof cwd === 'string' && cwd.length > 0, 'cwd must be set');
  assert(env !== null && typeof env === 'object', 'env must be set');
  assert(
    Number.isInteger(expectedStatus),
    'expected status must be an integer',
  );
  assert(
    relayStdoutTo === null ||
      relayStdoutTo === 'stdout' ||
      relayStdoutTo === 'stderr',
    'invalid stdout relay target',
  );
  assert(
    relayStderrTo === null ||
      relayStderrTo === 'stdout' ||
      relayStderrTo === 'stderr',
    'invalid stderr relay target',
  );

  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
  });

  assert(result.error === undefined, result.error?.message ?? 'spawn failed');
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

  if (relayStdoutTo !== null) {
    relayOutput(relayStdoutTo, result.stdout);
  }
  if (relayStderrTo !== null) {
    relayOutput(relayStderrTo, result.stderr);
  }

  return result;
}

function runNpm(args, options = {}) {
  const { env = process.env } = options;
  if (typeof npmCliPath === 'string' && npmCliPath.length > 0) {
    return run(process.execPath, [npmCliPath, ...args], { ...options, env });
  }

  return run('npm', args, { ...options, env });
}

function parseJson(rawValue, description) {
  assert.equal(typeof rawValue, 'string', `${description} must be a string`);
  assert(rawValue.trim().length > 0, `${description} must not be empty`);

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`${description} was not valid JSON`, { cause: error });
  }
}

function assertString(value, description) {
  assert.equal(typeof value, 'string', `${description} must be a string`);
  assert(value.length > 0, `${description} must not be empty`);
  return value;
}

function logDefault(message) {
  const normalizedMessage = assertString(message, 'log message');
  process.stderr.write(`${normalizedMessage}\n`);
}

function parseCliArgs(argv) {
  assert(Array.isArray(argv), 'argv must be an array');

  let build = false;
  let packDestination = projectRoot;
  let metadataFile = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    assertString(argument, 'CLI argument');

    if (argument === '--build') {
      build = true;
      continue;
    }

    if (argument === '--pack-destination') {
      index += 1;
      assert(index < argv.length, '--pack-destination requires a value');
      packDestination = assertString(argv[index], '--pack-destination value');
      continue;
    }

    if (argument === '--metadata-file') {
      index += 1;
      assert(index < argv.length, '--metadata-file requires a value');
      metadataFile = assertString(argv[index], '--metadata-file value');
      continue;
    }

    throw new Error(`unsupported argument: ${argument}`);
  }

  return {
    build,
    packDestination,
    metadataFile,
  };
}

export async function packRelease(options = {}) {
  const {
    build = false,
    packDestination = projectRoot,
    metadataFile = null,
    env = null,
    log = logDefault,
  } = options;
  assert.equal(typeof build, 'boolean', 'build must be a boolean');
  assert.equal(
    typeof packDestination,
    'string',
    'pack destination must be a string',
  );
  assert(packDestination.length > 0, 'pack destination must not be empty');
  assert(
    metadataFile === null || typeof metadataFile === 'string',
    'metadata file must be a string or null',
  );
  assert(typeof log === 'function', 'log must be a function');

  const resolvedPackDestination = resolve(projectRoot, packDestination);
  const resolvedMetadataFile =
    metadataFile === null ? null : resolve(projectRoot, metadataFile);
  const resolvedEnv =
    env ??
    getDefaultEnv([
      resolvedPackDestination,
      resolvedMetadataFile === null ? '' : dirname(resolvedMetadataFile),
    ]);
  assert(
    resolvedEnv !== null && typeof resolvedEnv === 'object',
    'resolved env must be an object',
  );

  const packageJson = parseJson(
    await readFile(join(projectRoot, 'package.json'), 'utf8'),
    'package.json',
  );
  assert(
    packageJson !== null && typeof packageJson === 'object',
    'package.json must parse to an object',
  );
  const packageName = assertString(packageJson.name, 'package.json name');
  const packageVersion = assertString(
    packageJson.version,
    'package.json version',
  );

  await mkdir(resolvedPackDestination, { recursive: true });

  if (build) {
    log('Building package contents for release tarball...');
    runNpm(['run', 'build'], {
      env: resolvedEnv,
      relayStdoutTo: 'stderr',
      relayStderrTo: 'stderr',
    });
  }

  log(`Packing release tarball into ${resolvedPackDestination}...`);
  const packResult = runNpm(
    [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      resolvedPackDestination,
    ],
    {
      env: resolvedEnv,
      relayStderrTo: 'stderr',
    },
  );
  const packMetadata = parseJson(packResult.stdout, 'npm pack output');
  assert(Array.isArray(packMetadata), 'npm pack output must be an array');
  assert.equal(
    packMetadata.length,
    1,
    'npm pack output must contain one entry',
  );

  const [packEntry] = packMetadata;
  assert(
    packEntry !== null && typeof packEntry === 'object',
    'pack entry must be an object',
  );
  assert.equal(packEntry.name, packageName, 'packed package name mismatch');
  assert.equal(
    packEntry.version,
    packageVersion,
    'packed package version mismatch',
  );

  const tarballFilename = assertString(
    packEntry.filename,
    'packed tarball filename',
  );
  const tarballPath = join(resolvedPackDestination, tarballFilename);
  await access(tarballPath, fsConstants.R_OK);
  const tarballStats = await stat(tarballPath);
  assert(tarballStats.isFile(), 'packed tarball must be a file');
  assert(tarballStats.size > 0, 'packed tarball must not be empty');

  const tarballContents = await readFile(tarballPath);
  const checksumSha256 = createHash('sha256')
    .update(tarballContents)
    .digest('hex');
  const checksumFilename = `${tarballFilename}.sha256`;
  const checksumPath = join(resolvedPackDestination, checksumFilename);
  const checksumContents = `${checksumSha256}  ${tarballFilename}\n`;
  await writeFile(checksumPath, checksumContents, 'utf8');

  const packFiles = packEntry.files;
  assert(Array.isArray(packFiles), 'pack entry must include files');
  const packedPaths = packFiles.map((entry) => {
    assert(
      entry !== null && typeof entry === 'object',
      'pack file entry must be an object',
    );
    return assertString(entry.path, 'pack file path');
  });

  const metadata = {
    packageName,
    packageVersion,
    tarballFilename,
    tarballPath,
    tarballSizeBytes: tarballStats.size,
    checksumFilename,
    checksumPath,
    checksumSha256,
    npmShasum:
      typeof packEntry.shasum === 'string' && packEntry.shasum.length > 0
        ? packEntry.shasum
        : null,
    packedPaths,
  };

  if (resolvedMetadataFile !== null) {
    await mkdir(dirname(resolvedMetadataFile), { recursive: true });
    await writeFile(
      resolvedMetadataFile,
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );
  }

  return metadata;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const metadata = await packRelease(options);
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

if (invokedScriptPath === currentScriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
