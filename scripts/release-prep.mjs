#!/usr/bin/env node
import { resolve } from 'node:path';
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

const VERSION_FILE_PATHS = Object.freeze(['package.json', 'package-lock.json']);

// The env override is intentionally scoped to external release tools
// (release-it, Communique, and verification). Git operations use process.env
// because the supported entrypoint is spawning this script with the desired env.
export function releasePrep(argv = process.argv.slice(2), env = process.env) {
  const options = parsePrepArgs(argv);
  const root = assertRepoRoot(process.cwd());
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
      ...VERSION_FILE_PATHS,
      'CHANGELOG.md',
    ]);
    assertExpectedFilesChanged(changedFiles, [
      ...VERSION_FILE_PATHS,
      'CHANGELOG.md',
    ]);
    stageFiles(root, [...VERSION_FILE_PATHS, 'CHANGELOG.md']);
  } else {
    const changedFiles = assertAllowedChangedFiles(root, [
      ...VERSION_FILE_PATHS,
      'CHANGELOG.md',
    ]);
    if (changedFiles.includes('CHANGELOG.md')) {
      throw new Error('CHANGELOG.md must not change when using --changelog ci');
    }
    assertExpectedFilesChanged(changedFiles, VERSION_FILE_PATHS);
    stageFiles(root, VERSION_FILE_PATHS);
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
