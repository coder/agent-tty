---
name: release-maintainer
description: Internal maintainer SOP for version bumps, release PRs, tagging, publishing, and post-publish verification in this repository.
advertise: false
---

# agent-tty release maintainer SOP

This is a project-local maintainer skill for `agent-tty` releases. The canonical process lives in [`docs/RELEASE-PROCESS.md`](../../../docs/RELEASE-PROCESS.md); use this skill as an agent wrapper around that document, not as a second copy of the release recipe.

## When to use this skill

Use this skill when you are asked to:

- bump the package version for a stable release or prerelease,
- create or manage the release PR,
- wait for CI and merge the release PR,
- tag and publish a release,
- or verify the published npm package and GitHub Release assets.

## Core guardrails

- Re-read and follow `docs/RELEASE-PROCESS.md` before making release changes.
- Do **not** release from an unmerged branch. The release tag must reference a commit already merged into `main`.
- Keep the version bump minimal unless the user explicitly asks for additional release-related changes.
- Follow the repo's PR body/footer requirements from `AGENTS.md` when creating the release PR.
- Treat `gh auth status` as advisory only. When access looks suspicious, verify with a real API call instead.
- Run post-publish verification under Node 24. If the ambient shell is older, point `NODE_BIN` at an explicit Node 24 binary.
- For `doctor --json`, the health signal is `.result.ok`; the outer `.ok` field only says the CLI command envelope succeeded.
- If this skill conflicts with `docs/RELEASE-PROCESS.md`, stop and update the skill or ask for direction before continuing.

## Preflight

1. Re-read `RELEASE.md`, `ROADMAP.md`, and `docs/RELEASE-PROCESS.md`.
2. Confirm the workspace is clean and based on up-to-date `main`.
3. Confirm release-note automation prerequisites from `docs/RELEASE-PROCESS.md` are available.
4. Verify GitHub CLI access with a real API call:

```bash
gh api graphql -f query='query { viewer { login } }'
```

5. Prefer `mise run ci` when `mise` is available; otherwise use `npm run verify`.

## Execution Checklist

- Follow the current version-bump, changelog, PR, merge, tag, publish, and verification steps in `docs/RELEASE-PROCESS.md`.
- Keep release PR commits narrowly scoped to release metadata, changelog updates, and required lockfile or release-process updates.
- After opening a release PR, account for the `Release Changelog` workflow possibly pushing a `CHANGELOG.md` commit back to the branch.
- Use structured `gh run view ... --json status,conclusion,jobs` output for agent-driven CI waiting.
- After merging the release PR, tag the merged `main` commit only.
- Verify both npm installation and GitHub Release asset installation before announcing the release.

## Failure Recovery Reminders

- If a release tag was pushed before the PR merged, cancel the workflow run, delete the remote tag, delete the local tag, and redo the release through the PR-first flow.
- If the GitHub Release exists but assets or npm publish are missing, inspect the `Release` workflow run before attempting any manual repair.
- If `gh auth status` looks broken but the real API calls succeed, keep using real `gh` command results as the source of truth.
- If installation succeeds with an `EBADENGINE` warning because `npm` itself is running under an older Node, rerun the installed CLI under Node 24 before deciding whether the release is healthy.
