---
status: accepted
---

# Use release-it only for release prep

## Context

agent-tty already has a tag-triggered publish pipeline in `.github/workflows/release.yml`. That pipeline validates the release tag against `package.json`, checks that the tagged commit is reachable from `main`, runs CI, creates one release tarball, uploads checksum assets, generates Communique release notes, creates or updates the GitHub Release, and publishes the same tarball to npm via trusted publishing/OIDC.

The manual release-prep path still had friction: maintainers had to create the release branch, run `npm version ... --no-git-tag-version`, optionally generate a changelog, and remember not to tag or publish before the PR merged.

## Decision

Use a pinned `release-it` dependency only behind project-specific Release Prep Workflow commands. The release-it config disables commit, tag, push, npm publish, GitHub Release, and GitLab Release side effects. The wrapper script owns repository-specific guardrails, branch creation, changelog mode, allowlisted staging, and the single local release-prep commit.

The Release Finalization Step does not use release-it. It uses repository-specific checks plus plain `git tag -a` and `git push origin <tag>` after the release-prep PR has landed on `main`.

The existing Publish Pipeline remains authoritative for packaging, GitHub Release assets, release notes, npm trusted publishing, and prerelease dist-tags.

## Consequences

- Maintainers run `npm run release:prep` and `npm run release:finalize`, not raw `release-it` commands.
- Release prep is non-interactive, exact-version-first, and local-only in the first slice.
- Release prep can choose `--changelog local` for a reviewed local Communique changelog or `--changelog ci` to let the release-changelog workflow update `CHANGELOG.md` on the release branch.
- Release finalization can only tag clean, synced `main` after the prep PR lands.
- npm publishing remains impossible from local release-prep tooling.
