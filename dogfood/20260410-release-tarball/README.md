# Release tarball proof bundle

This bundle captures a 2026-04-10 local verification pass for the GitHub-release tarball workflow.

## What it verifies

- `npm run pack:release` produced a tarball, checksum file, and metadata JSON under `release-artifact/`.
- The tarball installed successfully into an isolated prefix.
- The installed CLI passed `version --json` and `doctor --json` checks when invoked with a Node 24 runtime.
- `screenshots/01-release-proof.png`, `recordings/release-proof.cast`, and `videos/release-proof.webm` provide reviewer-facing proof of the summarized validation output.

## Important limitation

This workspace does not have the GitHub release credentials and remote tag context needed to publish or inspect a live GitHub Actions release run.
The hosted workflow itself is implemented in `.github/workflows/release.yml`; this bundle covers the local pack/install/verify leg that the workflow reuses.
