# Release process

`RELEASE.md` defines the shipping contract. This document describes how maintainers should validate, version, tag, and publish that contract on GitHub Releases and npm.

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

Because `main` is pull-request-only, the correct release flow is:

1. create a release branch from `main`,
2. bump the version **without creating a tag yet**,
3. open and merge a PR,
4. tag the merged `main` commit,
5. let the `Release` workflow publish the GitHub Release assets and npm package.

Do **not** run `npm version ...` on `main` and then push `HEAD --follow-tags`; GitHub will reject the protected-branch push but still accept the tag, which can start a release from an unmerged commit.

## Prepare the version-bump PR

Start from an up-to-date `main` checkout:

```bash
git checkout main
git pull origin main
```

### Stable release examples

Create a release branch and bump the version **without tagging**:

```bash
git switch -c release/0.1.1
npm version patch --no-git-tag-version
```

You can also choose the exact stable version explicitly:

```bash
npm version 0.1.1 --no-git-tag-version
```

### Prerelease examples

First beta on the next patch line:

```bash
git switch -c release/0.1.1-beta.0
npm version prepatch --preid beta --no-git-tag-version
```

Next beta on the same line:

```bash
npm version prerelease --preid beta --no-git-tag-version
```

Release candidate with an exact version:

```bash
npm version 0.1.1-rc.0 --no-git-tag-version
```

Versions containing a hyphen, such as `-beta.0` or `-rc.0`, are published by the workflow as GitHub prereleases and published to the matching npm dist-tag (`beta`, `rc`, and so on).

### Open the release PR

Release branches named `release/*` are watched by the `Release Changelog` workflow. When `package.json` changes the package version and `CHANGELOG.md` does not already contain that version, the workflow runs:

```bash
communique generate "v<version>" --changelog --repo coder/agent-tty
```

and commits the resulting `CHANGELOG.md` update back to the release branch.
When it pushes that bot commit, it dispatches the CI and skill-validation
workflows for the updated release branch so protected-branch checks can run
against the new head commit.

If you want to inspect or update the changelog before opening the PR, run the same command locally after `npm version ... --no-git-tag-version` and include `CHANGELOG.md` in the release commit:

```bash
VERSION=$(node --input-type=module -e "import pkg from './package.json' with { type: 'json' }; process.stdout.write(pkg.version)")
communique generate "v${VERSION}" --changelog --repo coder/agent-tty
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): ${VERSION}"
```

After the version bump is committed:

```bash
git push -u origin <release-branch>
gh pr create --base main --head <release-branch> --title "chore(release): <version>"
```

Run the normal PR checks, get approval as needed, and merge the PR.

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

After the release PR has merged:

```bash
git checkout main
git pull origin main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

For prereleases, use the full prerelease tag name, for example:

```bash
git tag -a v0.1.1-beta.0 -m "v0.1.1-beta.0"
git push origin v0.1.1-beta.0
```

The tag must match `package.json` exactly:

- `package.json`: `0.1.1`
- tag: `v0.1.1`

or:

- `package.json`: `0.1.1-beta.0`
- tag: `v0.1.1-beta.0`

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

## Recover from an accidental tag push

If you accidentally push a release tag before the version-bump PR is merged:

1. cancel the in-progress workflow run,
2. delete the remote tag,
3. delete the local tag,
4. redo the release through the PR-first flow above.

Example cleanup:

```bash
gh run cancel <run-id>
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
```

Then create or update the release branch PR, merge it, and tag the merged `main` commit.

## Proof expectations

- Keep at least one current release-readiness bundle under `dogfood/`.
- Keep evergreen scenario bundles easy to discover from the dogfood catalog.
- When a change affects release, packaging, install, renderer, screenshot, wait, export, or review UX, include screenshots and recordings in the relevant proof bundle when feasible.
