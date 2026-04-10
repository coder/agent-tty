# Release process

`RELEASE.md` defines the shipping contract. This document describes how maintainers should validate, version, tag, and publish that contract on GitHub Releases.

## Release prerequisites

1. Re-read [`../RELEASE.md`](../RELEASE.md) and confirm it still matches the shipped surface.
2. Re-read [`../ROADMAP.md`](../ROADMAP.md) and confirm deferred work is not mixed back into the release contract.
3. Verify the primary docs route correctly from [`../README.md`](../README.md) to release, roadmap, design, and dogfood materials.
4. Review [`../dogfood/CATALOG.md`](../dogfood/CATALOG.md) and make sure the release-signoff bundle is current and easy to find.
5. Confirm npm publication is still intentionally out of scope for this workflow; the supported hosted install path today is the GitHub Release tarball asset.
6. Remember that `main` is protected: release changes must land through a pull request, and the release tag must be created only after that PR is merged.

## Validation bar

Preferred local validation uses `mise`:

```bash
mise run ci
```

If `mise` is unavailable, run:

```bash
npm run verify
```

If the public skill changed, also run:

```bash
npm run intent:validate
```

`mise run ci` exercises formatting, lint, typecheck, tests, build, and the install smoke. The install smoke validates the shared release tarball packer plus the guaranteed tarball install route before any publish step runs.

## Prepare the release asset locally (optional but recommended)

Use the same release packer that CI relies on:

```bash
RELEASE_DIR=$(mktemp -d)
npm run build
npm run pack:release -- --pack-destination "$RELEASE_DIR" --metadata-file "$RELEASE_DIR/package-metadata.json"
cat "$RELEASE_DIR/package-metadata.json"
sha256sum -c "$RELEASE_DIR"/*.tgz.sha256
```

That command produces the same tarball, checksum, and metadata shape that the GitHub release workflow uploads.

## Release flow overview

Because `main` is pull-request-only, the correct release flow is:

1. create a release branch from `main`,
2. bump the version **without creating a tag yet**,
3. open and merge a PR,
4. tag the merged `main` commit,
5. let the `Release` workflow publish the GitHub Release assets.

Do **not** run `npm version ...` on `main` and then push `HEAD --follow-tags`; GitHub will reject the protected-branch push but still accept the tag, which can start a release from an unmerged commit.

## Prepare the version-bump PR

Start from an up-to-date `main` checkout:

```bash
git checkout main
git pull origin main
```

### Stable release examples

Create a release branch, bump the version **without tagging**, and commit the result:

```bash
git switch -c release/0.1.1
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): 0.1.1"
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
git add package.json package-lock.json
git commit -m "chore(release): 0.1.1-beta.0"
```

Next beta on the same line:

```bash
npm version prerelease --preid beta --no-git-tag-version
```

Release candidate with an exact version:

```bash
npm version 0.1.1-rc.0 --no-git-tag-version
```

Versions containing a hyphen, such as `-beta.0` or `-rc.0`, are published by the workflow as GitHub prereleases.

### Open the release PR

After the version bump is committed:

```bash
git push -u origin <release-branch>
gh pr create --base main --head <release-branch> --title "chore(release): <version>"
```

Run the normal PR checks, get approval as needed, and merge the PR.

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

## Publish the GitHub Release

The hand-curated workflow lives at [`.github/workflows/release.yml`](../.github/workflows/release.yml).
It triggers automatically on pushed `v*` tags, and it can also be rerun manually for an already-existing remote tag via the **Release** workflow's `tag` input.

The workflow will:

- resolve the release tag and check out that exact ref,
- verify the tagged commit is already reachable from the default branch,
- validate that the tag matches the `package.json` version,
- run `mise run ci`,
- pack the verified tarball with `npm run pack:release`,
- upload the tarball, checksum, and metadata JSON as workflow artifacts,
- and create or update the GitHub Release with the `.tgz` and `.sha256` assets attached.

The workflow intentionally splits artifact preparation from GitHub release publication so a future npm-publish job can depend on the verified `prepare-release` outputs instead of rebuilding the package.

## Verify the published release assets

After the workflow succeeds, verify the hosted asset before announcing the release:

```bash
VERSION=<version>
RELEASE_TAG="v${VERSION}"
RELEASE_TGZ="agent-terminal-${VERSION}.tgz"

DOWNLOAD_DIR=$(mktemp -d)
INSTALL_PREFIX=$(mktemp -d)
AGENT_TERMINAL_HOME=$(mktemp -d)

gh release download "$RELEASE_TAG" --repo coder/agent-terminal --dir "$DOWNLOAD_DIR" --pattern "$RELEASE_TGZ"
gh release download "$RELEASE_TAG" --repo coder/agent-terminal --dir "$DOWNLOAD_DIR" --pattern "${RELEASE_TGZ}.sha256"
(
  cd "$DOWNLOAD_DIR"
  sha256sum -c "${RELEASE_TGZ}.sha256"
)

npm install -g --prefix "$INSTALL_PREFIX" "$DOWNLOAD_DIR/$RELEASE_TGZ"
"$INSTALL_PREFIX"/bin/agent-terminal version --json
"$INSTALL_PREFIX"/bin/agent-terminal --home "$AGENT_TERMINAL_HOME" doctor --json
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

## Future npm publish seam

The release workflow intentionally stops at the GitHub Release asset.
A future npm-publish job should depend on `prepare-release`, consume the verified tarball and metadata JSON that job already emits, and publish without rebuilding the package.
Package name and registry decisions remain a separate follow-up because the current npm name is not settled.
