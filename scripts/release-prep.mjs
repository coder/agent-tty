#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertAllowedChangedFiles,
  assertCleanWorkingTree,
  assertExactlyOneCommitSince,
  assertExpectedFilesChanged,
  assertGitIdentity,
  assertLocalChangelogPrerequisites,
  assertPackageVersionsMatch,
  assertReleaseBranchAvailable,
  assertRepoRoot,
  assertSyncedMain,
  assertTargetVersionIsGreater,
  createCommit,
  exitWithError,
  parsePrepArgs,
  runCommunique,
  runGit,
  runReleaseIt,
  runVerification,
  stageFiles,
} from './release-helpers.mjs';

// `package-lock.json` is included in the version-file allowlist only when it
// actually exists. After the aube migration (PR #91) the repo no longer ships
// one, but the npm-lockfile path is still supported for downstream consumers
// that re-introduce `package-lock.json`.
function resolveVersionFilePaths(root) {
  return existsSync(join(root, 'package-lock.json'))
    ? Object.freeze(['package.json', 'package-lock.json'])
    : Object.freeze(['package.json']);
}

// The env override is intentionally scoped to external release tools
// (release-it, Communique, and verification). Git operations use process.env
// because the supported entrypoint is spawning this script with the desired env.
export function releasePrep(argv = process.argv.slice(2), env = process.env) {
  const options = parsePrepArgs(argv);
  const root = assertRepoRoot(process.cwd());
  const versionFilePaths = resolveVersionFilePaths(root);
  const { packageVersion } = assertPackageVersionsMatch(root);
  assertTargetVersionIsGreater(packageVersion, options.version);

  if (options.changelog === 'local') {
    assertLocalChangelogPrerequisites(root, options.version, env);
  }

  assertCleanWorkingTree(root);
  assertSyncedMain(root);
  assertGitIdentity(root, 'creating the release-prep commit');
  const releaseBranch = assertReleaseBranchAvailable(root, options.version);
  const baseRevision = runGit(root, ['rev-parse', 'HEAD']).stdout.trim();

  runGit(root, ['switch', '-c', releaseBranch], { stdio: 'inherit' });
  runReleaseIt(root, options.version, env);
  assertPackageVersionsMatch(root, options.version);

  if (options.changelog === 'local') {
    runCommunique(root, options.version, env);
    const changedFiles = assertAllowedChangedFiles(root, [
      ...versionFilePaths,
      'CHANGELOG.md',
    ]);
    assertExpectedFilesChanged(changedFiles, [
      ...versionFilePaths,
      'CHANGELOG.md',
    ]);
    stageFiles(root, [...versionFilePaths, 'CHANGELOG.md']);
  } else {
    const changedFiles = assertAllowedChangedFiles(root, [
      ...versionFilePaths,
      'CHANGELOG.md',
    ]);
    if (changedFiles.includes('CHANGELOG.md')) {
      throw new Error('CHANGELOG.md must not change when using --changelog ci');
    }
    assertExpectedFilesChanged(changedFiles, versionFilePaths);
    stageFiles(root, versionFilePaths);
  }

  createCommit(root, `chore(release): ${options.version}`);
  assertExactlyOneCommitSince(root, baseRevision);
  assertCleanWorkingTree(root);

  if (options.verify) {
    runVerification(root, env);
    assertCleanWorkingTree(root);
  }

  process.stdout.write(
    [
      `Release prep commit created on ${releaseBranch}.`,
      '',
      'Next commands:',
      `git push -u origin ${releaseBranch}`,
      `gh pr create --base main --head ${releaseBranch} --title "chore(release): ${options.version}"`,
      '',
    ].join('\n'),
  );
}

const invokedPath =
  process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    releasePrep();
  } catch (error) {
    exitWithError(error);
  }
}
