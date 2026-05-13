# Release process

[`../RELEASE.md`](../RELEASE.md) defines the supported product contract. This document is the canonical maintainer process for validating, versioning, tagging, and publishing that contract on GitHub Releases and npm.

## One-time npm trusted publishing setup

1. Ensure the intended npm package name remains `agent-tty`.
2. On npm, configure trusted publishing for `agent-tty` with these GitHub Actions settings:
   - organization or user: `coder`
   - repository: `agent-tty`
   - workflow filename: `release.yml` (the workflow file committed at `.github/workflows/release.yml`)
   - environment name: leave empty unless this workflow later adds a protected GitHub environment for publishing
3. After the first successful trusted publish, restrict the package's npm publishing access to require 2FA and disallow traditional tokens.
4. Keep the package metadata aligned with npm provenance expectations:
   - `package.json.name` must stay `agent-tty`
   - `package.json.repository.url` must stay `git+https://github.com/coder/agent-tty.git`
   - `package.json.publishConfig.registry` must stay `https://registry.npmjs.org/`
5. No GitHub Actions secret is required for npm publishing in this flow; the workflow uses GitHub-hosted runners plus OIDC trusted publishing.

## Release prerequisites

1. Re-read [`../RELEASE.md`](../RELEASE.md) and confirm it still matches the shipped surface.
2. Re-read [`../ROADMAP.md`](../ROADMAP.md) and confirm deferred work is not mixed back into the release contract.
3. Verify the primary docs route correctly from [`../README.md`](../README.md) to release, roadmap, design, and dogfood materials.
4. Review [`../dogfood/CATALOG.md`](../dogfood/CATALOG.md) and make sure the release-signoff bundle is current and easy to find.
5. Confirm the published package metadata still points at `agent-tty` and the public GitHub repository.
6. Remember that `main` is protected: release changes must land through a pull request, and the release tag must be created only after that PR is merged.
7. Confirm release-note automation has an LLM provider secret available in GitHub Actions:
   - default/recommended: `ANTHROPIC_API_KEY`
   - OpenAI-compatible fallback: `OPENAI_API_KEY` plus a repository variable named `COMMUNIQUE_MODEL`

## GitHub CLI readiness

This flow assumes `gh` can create PRs, inspect checks, merge, and create releases. `gh auth status` is useful for a quick summary, but in some environments it can report a stale or misleading state even when real GitHub API calls still work.

Before treating release automation as blocked, verify with a real API call such as:

```bash
gh api graphql -f query='query { viewer { login } }'
```

If that succeeds, prefer the result of the real `gh` operation over the status summary.

## Validation bar

Preferred local validation uses `mise`:

```bash
mise run ci
```

GitHub Actions installs mise-managed tools from the committed [`../mise.lock`](../mise.lock) with `--locked`. If `mise.toml` tool versions or supported CI platforms change, regenerate the lock before opening the release PR:

```bash
mise lock
```

If `mise` is unavailable, run:

```bash
npm run verify
```

If the public bootstrap under `skills/` or the bundled runtime skills under `skill-data/` changed, also run:

```bash
npm run intent:validate
```

`mise run ci` exercises formatting, GitHub Actions workflow linting, lint, typecheck, tests, build, and the install smoke. The install smoke validates the shared release tarball packer plus the required tarball install route before any publish step runs.

## Prepare the release asset locally (optional but recommended)

Use the same release packer that CI relies on:

```bash
RELEASE_DIR=$(mktemp -d)
npm run build
npm run pack:release -- --pack-destination "$RELEASE_DIR" --metadata-file "$RELEASE_DIR/package-metadata.json"
cat "$RELEASE_DIR/package-metadata.json"
sha256sum -c "$RELEASE_DIR"/*.tgz.sha256
```

When skill packaging changes, also inspect `npm pack --dry-run` output to confirm the tarball still includes both `skills/` (bootstrap) and `skill-data/` (runtime skills).

That command produces the same tarball, checksum, and metadata shape that the GitHub release workflow uploads and later reuses for npm publishing.

## Release flow overview

Because `main` is pull-request-only, the release process has three named parts:

1. **Release Prep Workflow**: prepare a reviewable release branch and one local release-prep commit.
2. **Release Finalization Step**: after the release PR merges, create and push the matching annotated release tag from clean, synced `main`.
3. **Publish Pipeline**: let the tag-triggered `Release` workflow publish GitHub assets and npm.

Do **not** run `npm version ...` on `main` and then push `HEAD --follow-tags`; GitHub will reject the protected-branch push but still accept the tag, which can start a release from an unmerged commit.

The primary commands are project-owned wrappers:

```bash
npm run release:prep -- --version <exact-semver> --changelog local|ci
npm run release:finalize
```

`release-it` is an implementation detail of the prep command only. Do not call raw `release-it` for agent-tty releases.

## Prepare the version-bump PR

Start from a clean, up-to-date `main` checkout:

```bash
git checkout main
git pull origin main
```

Choose the exact release version. Increment aliases such as `patch`, `prepatch`, and `prerelease` are intentionally not part of the first scripted workflow; pass the exact semantic version instead.

Stable release example:

```bash
npm run release:prep -- --version 0.1.1 --changelog ci
```

Prerelease example:

```bash
npm run release:prep -- --version 0.1.1-beta.0 --changelog ci
```

Versions containing a hyphen, such as `-beta.0` or `-rc.0`, are published by the workflow as GitHub prereleases and published to the matching npm dist-tag (`beta`, `rc`, and so on).

### Changelog mode

Use `--changelog ci` for the default maintainer path. The prep commit will contain only the version files — `package.json` plus `package-lock.json` when present (after PR #91 this repo uses `aube-lock.yaml` instead, so the prep commit on the default branch contains only `package.json`). The `Release Changelog` workflow will update `CHANGELOG.md` on the release branch when needed.

```bash
npm run release:prep -- --version <version> --changelog ci
```

Use `--changelog local` only when you want to inspect the Communique changelog before opening the PR and have the required local credentials/tooling available:

```bash
npm run release:prep -- --version <version> --changelog local
```

Local changelog generation requires either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; when using only `OPENAI_API_KEY`, set `COMMUNIQUE_MODEL`. It also requires `communique` on `PATH` and GitHub API auth through `GITHUB_TOKEN` or an authenticated `gh` session. If those prerequisites are unavailable, rerun with `--changelog ci`.

Add `--verify` when you want the prep script to run the full local validation bar after creating the release-prep commit:

```bash
npm run release:prep -- --version <version> --changelog ci --verify
```

The prep script validates release-specific invariants, creates `release/<version>` locally, updates the version files through pinned release-it configuration, optionally updates `CHANGELOG.md`, stages only allowlisted release-prep files, and creates exactly one commit:

```text
chore(release): <version>
```

It does not push the branch or open the pull request. After it succeeds, push and open the PR with the commands printed by the script:

```bash
git push -u origin release/<version>
gh pr create --base main --head release/<version> --title "chore(release): <version>"
```

Release branches named `release/*` are watched by the `Release Changelog` workflow. When `package.json` changes the package version and `CHANGELOG.md` does not already contain that version, the workflow runs:

```bash
communique generate "v<version>" --changelog --repo coder/agent-tty
```

and commits the resulting `CHANGELOG.md` update back to the release branch. When it pushes that bot commit, it dispatches the CI and skill-validation workflows for the updated release branch so protected-branch checks can run against the new head commit.

### Manual prep fallback

If the scripted prep path is blocked, use the manual fallback only from a clean, up-to-date `main` checkout. Stage `package-lock.json` only if your checkout still has one (post-PR #91 the repo is aube-only and the file is absent):

```bash
git switch -c release/<version>
npm version <version> --no-git-tag-version
git add package.json
[[ -f package-lock.json ]] && git add package-lock.json
git commit -m "chore(release): <version>"
git push -u origin release/<version>
gh pr create --base main --head release/<version> --title "chore(release): <version>"
```

For the local changelog variant, run Communique after `npm version ... --no-git-tag-version` and include `CHANGELOG.md` in the same commit:

```bash
communique generate "v<version>" --changelog --repo coder/agent-tty
git add package.json CHANGELOG.md
[[ -f package-lock.json ]] && git add package-lock.json
git commit -m "chore(release): <version>"
```

## Wait for CI and merge the release PR

For interactive use, `gh pr checks <pr-number> --watch` is fine. For automation or agent-driven release work, prefer inspecting the workflow run directly so you can wait on structured `status` and `conclusion` fields instead of parsing live terminal refresh output.

Typical sequence:

```bash
gh pr checks <pr-number>
gh run list --branch <release-branch> --event pull_request --limit 5
gh run view <run-id> --json status,conclusion,jobs
```

If the PR still cannot be merged after every required check passes, inspect the base-branch policy first. When normal merge and `--auto` are unavailable but an authorized releaser is allowed to override the policy, use:

```bash
gh pr merge <pr-number> --squash --admin --delete-branch
```

Use `--admin` sparingly and only after confirming the required release checks succeeded.

## Tag the merged `main` commit

After the release PR has merged, use the Release Finalization Step from clean, synced `main`:

```bash
git checkout main
git pull origin main
npm run release:finalize
```

Add `--verify` when you want to run the full local validation bar immediately before tagging:

```bash
npm run release:finalize -- --verify
```

The finalize script verifies that `package.json` and `package-lock.json` agree, derives the release tag as `v${package.json.version}`, rejects pre-existing local or remote tags, creates an annotated tag, and pushes only that tag.

The tag must match `package.json` exactly:

- `package.json`: `0.1.1`
- tag: `v0.1.1`

or:

- `package.json`: `0.1.1-beta.0`
- tag: `v0.1.1-beta.0`

### Manual tag fallback

If the scripted finalization path is blocked after the release PR has merged, run the equivalent manual commands from clean, synced `main`:

```bash
VERSION=$(node --input-type=module -e "import pkg from './package.json' with { type: 'json' }; process.stdout.write(pkg.version)")
git tag -a "v${VERSION}" -m "v${VERSION}"
git push origin "v${VERSION}"
```

### GitHub CLI alternative: create the tag and release in one step

If you already know the merged `main` commit SHA and want GitHub to create the tag and release together, this also works:

```bash
MERGED_SHA=<merge-commit-on-main>
gh release create v0.1.1-beta.0 \
  --target "$MERGED_SHA" \
  --prerelease \
  --latest=false \
  --title v0.1.1-beta.0 \
  --notes-file <notes-file>
```

`gh release create` creates the tag on the specified merged commit and still triggers the `Release` workflow via the pushed `v*` tag. Use the prerelease flags only for prerelease versions; omit them for stable releases.

## Publish the GitHub Release and npm package

The hand-curated workflow lives at [`.github/workflows/release.yml`](../.github/workflows/release.yml).
It triggers automatically on pushed `v*` tags, and it can also be rerun manually for an already-existing remote tag via the **Release** workflow's `tag` input.

The workflow will:

- resolve the release tag and check out that exact ref,
- install mise-managed tools from the committed lock file,
- verify the tagged commit is already reachable from the default branch,
- validate that the tag matches the `package.json` version,
- run `mise run ci`,
- pack the verified tarball with `npm run pack:release`,
- upload the tarball, checksum, and metadata JSON as workflow artifacts,
- generate Communique release notes for the tag,
- create or update the GitHub Release with Communique notes plus the deterministic install/checksum block and the `.tgz` / `.sha256` assets attached,
- and publish that same verified tarball to npm via trusted publishing on a GitHub-hosted runner.

Stable releases publish with npm's default `latest` dist-tag.
Prerelease versions publish with the prerelease identifier as the dist-tag, so `0.1.1-beta.0` publishes to the `beta` dist-tag and `0.1.1-rc.1` publishes to the `rc` dist-tag.

## Verify the published npm package

After the workflow succeeds, verify the exact npm package version before announcing the release. Run these checks under Node 24; if your interactive shell is older, point `NODE_BIN` at an explicit Node 24 binary first.

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

`doctor --json` uses the outer `ok` field for command-envelope success; the release-health signal is `.result.ok`.

If the release is a prerelease, also confirm the intended dist-tag points at the exact published version:

```bash
PACKAGE_NAME='agent-tty'
PACKAGE_VERSION='<version>'
DIST_TAG=$(node --input-type=module <<'EOF_NODE'
const version = process.env.PACKAGE_VERSION;
if (!version.includes('-')) {
  process.stdout.write('latest');
  process.exit(0);
}
const prerelease = version.split('-', 2)[1] ?? '';
const distTag = prerelease.split('.', 1)[0] ?? '';
if (distTag.length === 0) {
  throw new Error(`unable to derive dist-tag from ${version}`);
}
process.stdout.write(distTag);
EOF_NODE
)

npm view "$PACKAGE_NAME" dist-tags --json
printf 'expected dist-tag %s for %s\n' "$DIST_TAG" "$PACKAGE_VERSION"
```

## Verify the published GitHub Release assets

Also verify the hosted tarball fallback before announcing the release. Run these checks under Node 24 for the same reason as the npm verification above.

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

For private releases, authenticated download is the expected verification route.
If you are testing a public release and the direct asset URL is reachable in your environment, you can also verify the hosted install path directly with `npm install -g <release-asset-url>`.

## Failure and recovery

### Release prep fails after creating a branch

If `npm run release:prep` fails after creating `release/<version>`, inspect the local branch before deleting anything:

```bash
git status
git log --oneline --decorate --max-count=5
```

If there is no work worth preserving, return to `main`, delete the local release branch, and rerun from clean, synced `main`:

```bash
git switch main
git branch -D release/<version>
git pull origin main
npm run release:prep -- --version <version> --changelog ci
```

### Release finalization fails to push the tag

If `npm run release:finalize` creates the local tag but fails before pushing it, delete the local tag, fix the underlying issue, and retry from clean, synced `main`:

```bash
git tag -d v<version>
npm run release:finalize
```

### Release finalization pushes a tag but the Release workflow fails before publishing

If `npm run release:finalize` pushes the tag but the workflow fails before any GitHub Release or npm publish, fix the underlying issue on `main`. Delete and recreate the failed tag only if maintainers explicitly decide it is safe, and document the action.

Example tag cleanup, only after that explicit decision:

```bash
gh run cancel <run-id>
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
```

Then rerun the Release Finalization Step from clean, synced `main`.

### npm published but GitHub Release or verification fails

If npm publish succeeds, never reuse the same version, even if later GitHub Release asset creation or verification fails. Repair forward with a new version, or complete missing release assets manually according to maintainer policy.

### GitHub Release exists but npm publish fails

If the GitHub Release exists but npm publish fails, treat the release as partial. Verify which assets and npm state exist, then follow maintainer policy before deleting assets, deleting tags, or retrying publish automation.

### Accidental tag before merge

If a release tag is accidentally pushed before the version-bump PR is merged, cancel the in-progress workflow, delete the remote tag, delete the local tag, and redo the release through the PR-first flow above.

```bash
gh run cancel <run-id>
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
```

## Proof expectations

- Keep at least one current release-readiness bundle under `dogfood/`.
- Keep evergreen scenario bundles easy to discover from the dogfood catalog.
- When a change affects release, packaging, install, renderer, screenshot, wait, export, or review UX, include screenshots and recordings in the relevant proof bundle when feasible.
