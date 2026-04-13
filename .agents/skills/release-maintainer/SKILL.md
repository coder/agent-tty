---
name: release-maintainer
description: Internal maintainer SOP for version bumps, release PRs, tagging, publishing, and post-publish verification in this repository.
advertise: false
---

# agent-tty release maintainer SOP

This is a project-local maintainer skill for `agent-tty` releases. The canonical human policy lives in [`docs/RELEASE-PROCESS.md`](../../../docs/RELEASE-PROCESS.md); use this skill as the execution checklist when an agent is asked to cut or publish a release from this repository.

## When to use this skill

Use this skill when you are asked to:

- bump the package version for a stable release or prerelease,
- create or manage the release PR,
- wait for CI and merge the release PR,
- tag and publish a release,
- or verify the published npm package and GitHub Release assets.

## Core guardrails

- Do **not** release from an unmerged branch. The release tag must reference a commit already merged into `main`.
- Keep the version bump minimal unless the user explicitly asks for additional release-related changes.
- Follow the repo's PR body/footer requirements from `AGENTS.md` when creating the release PR.
- Treat `gh auth status` as advisory only. When access looks suspicious, verify with a real API call instead.
- Run post-publish verification under Node 24. If the ambient shell is older, point `NODE_BIN` at an explicit Node 24 binary.
- For `doctor --json`, the health signal is `.result.ok`; the outer `.ok` field only says the CLI command envelope succeeded.

## Preflight

1. Re-read `RELEASE.md`, `ROADMAP.md`, and `docs/RELEASE-PROCESS.md`.
2. Confirm the workspace is clean and based on up-to-date `main`.
3. Verify GitHub CLI access with a real API call:

```bash
gh api graphql -f query='query { viewer { login } }'
```

4. Prefer `mise run ci` when `mise` is available; otherwise use `npm run verify`.

## Prepare the version bump

Start from fresh `main`:

```bash
git checkout main
git pull origin main
```

Create a release branch and bump without tagging.

Stable patch release example:

```bash
git switch -c release/0.1.1
npm version patch --no-git-tag-version
```

First beta on the next patch line:

```bash
git switch -c release/0.1.1-beta.0
npm version prepatch --preid beta --no-git-tag-version
```

Next beta on the same line:

```bash
npm version prerelease --preid beta --no-git-tag-version
```

Then validate and commit the pure version bump:

```bash
npm run verify
npm run version:json
git add package.json package-lock.json
git commit -m "chore(release): <version>"
```

## Create the release PR

```bash
git push -u origin <release-branch>
gh pr create --base main --head <release-branch> --title "chore(release): <version>"
```

Before creating the PR, check whether one already exists for the release branch:

```bash
gh pr list --head <release-branch> --state all
```

## Wait for CI and merge the PR

Interactive waiting is fine with:

```bash
gh pr checks <pr-number> --watch
```

For automation or agent-driven waiting, prefer structured workflow inspection:

```bash
gh pr checks <pr-number>
gh run list --branch <release-branch> --event pull_request --limit 5
gh run view <run-id> --json status,conclusion,jobs
```

Merge the PR only after the required checks succeed.

Normal merge path:

```bash
gh pr merge <pr-number> --squash --delete-branch
```

If branch policy still blocks the merge after checks pass and an authorized releaser is allowed to override it:

```bash
gh pr merge <pr-number> --squash --admin --delete-branch
```

If remote refs look stale after the merge, refresh them before checking `origin/main` or deleted release branches:

```bash
git fetch origin --prune
```

## Tag and publish the release

Default to the documented tag flow unless the user explicitly asks for the GitHub CLI shortcut.

Documented flow:

```bash
git checkout main
git pull origin main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

If you are explicitly asked to create the tag and GitHub Release with `gh`, use the merged `main` commit SHA:

```bash
MERGED_SHA=<merge-commit-on-main>
gh release create vX.Y.Z \
  --target "$MERGED_SHA" \
  --title vX.Y.Z \
  --notes-file <notes-file>
```

For prereleases, also add:

```bash
--prerelease --latest=false
```

The release workflow should publish the verified tarball to both GitHub Releases and npm.

## Verify the published npm package

Run the installed CLI under Node 24:

```bash
PACKAGE_NAME='agent-tty'
PACKAGE_VERSION='<version>'
NODE_BIN=${NODE_BIN:-node}
INSTALL_PREFIX=$(mktemp -d)
AGENT_TTY_HOME=$(mktemp -d)

npm view "$PACKAGE_NAME" dist-tags --json
npm install -g --prefix "$INSTALL_PREFIX" "$PACKAGE_NAME@$PACKAGE_VERSION"
"$NODE_BIN" "$INSTALL_PREFIX/bin/agent-tty" version --json | jq -r '.result.cliVersion'
"$NODE_BIN" "$INSTALL_PREFIX/bin/agent-tty" --home "$AGENT_TTY_HOME" doctor --json | jq '.result.ok'
```

For prereleases, also confirm the expected dist-tag points at the exact version.

## Verify the published GitHub Release assets

```bash
VERSION=<version>
RELEASE_TAG="v${VERSION}"
RELEASE_TGZ="agent-tty-${VERSION}.tgz"
NODE_BIN=${NODE_BIN:-node}

DOWNLOAD_DIR=$(mktemp -d)
INSTALL_PREFIX=$(mktemp -d)
AGENT_TTY_HOME=$(mktemp -d)

gh release download "$RELEASE_TAG" --repo coder/agent-tty --dir "$DOWNLOAD_DIR" --pattern "$RELEASE_TGZ"
gh release download "$RELEASE_TAG" --repo coder/agent-tty --dir "$DOWNLOAD_DIR" --pattern "${RELEASE_TGZ}.sha256"
(
  cd "$DOWNLOAD_DIR"
  sha256sum -c "${RELEASE_TGZ}.sha256"
)

npm install -g --prefix "$INSTALL_PREFIX" "$DOWNLOAD_DIR/$RELEASE_TGZ"
"$NODE_BIN" "$INSTALL_PREFIX/bin/agent-tty" version --json | jq -r '.result.cliVersion'
"$NODE_BIN" "$INSTALL_PREFIX/bin/agent-tty" --home "$AGENT_TTY_HOME" doctor --json | jq '.result.ok'
```

## Failure recovery checklist

- If a release tag was pushed before the PR merged, cancel the workflow run, delete the remote tag, delete the local tag, and redo the release through the PR-first flow.
- If the GitHub Release exists but assets or npm publish are missing, inspect the `Release` workflow run before attempting any manual repair.
- If `gh auth status` looks broken but the real API calls succeed, keep using real `gh` command results as the source of truth.
- If installation succeeds with an `EBADENGINE` warning because `npm` itself is running under an older Node, rerun the installed CLI under Node 24 before deciding whether the release is healthy.
