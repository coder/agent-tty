#!/usr/bin/env node
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertCleanWorkingTree,
  assertGitIdentity,
  assertPackageVersionsMatch,
  assertReleaseTagAvailable,
  assertRepoRoot,
  assertSyncedMain,
  exitWithError,
  parseFinalizeArgs,
  parseSemver,
  runGit,
  runVerification,
} from './release-helpers.mjs';

// The env override is intentionally scoped to external verification. Git
// operations use process.env because the supported entrypoint is spawning this
// script with the desired env.
export function releaseFinalize(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const options = parseFinalizeArgs(argv);
  const root = assertRepoRoot(process.cwd());

  assertCleanWorkingTree(root);
  assertSyncedMain(root);
  const { packageVersion } = assertPackageVersionsMatch(root);
  parseSemver(packageVersion);
  assertGitIdentity(root, 'creating the release tag');
  const tagName = assertReleaseTagAvailable(root, packageVersion);

  if (options.verify) {
    runVerification(root, env);
    assertCleanWorkingTree(root);
  }

  runGit(root, ['tag', '-a', tagName, '-m', tagName], { stdio: 'inherit' });
  runGit(root, ['push', 'origin', tagName], { stdio: 'inherit' });

  process.stdout.write(
    [
      `Release tag ${tagName} pushed.`,
      'The tag-triggered Release workflow should now publish GitHub assets and npm.',
      'Watch the workflow and verify npm/GitHub release assets using docs/RELEASE-PROCESS.md.',
      '',
    ].join('\n'),
  );
}

const invokedPath =
  process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    releaseFinalize();
  } catch (error) {
    exitWithError(error);
  }
}
