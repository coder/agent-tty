# Release process

`RELEASE.md` defines the shipping contract. This document describes how maintainers should validate, package, and publish that contract on GitHub Releases.

## Release prerequisites

1. Re-read [`../RELEASE.md`](../RELEASE.md) and confirm it still matches the shipped surface.
2. Re-read [`../ROADMAP.md`](../ROADMAP.md) and confirm deferred work is not mixed back into the release contract.
3. Verify the primary docs route correctly from [`../README.md`](../README.md) to release, roadmap, design, and dogfood materials.
4. Review [`../dogfood/CATALOG.md`](../dogfood/CATALOG.md) and make sure the release-signoff bundle is current and easy to find.
5. Prefer cutting the release with npm's built-in version command so the package metadata and git tag are created together in one step.
6. Confirm npm publication is still intentionally out of scope for this workflow; the supported hosted install path today is the GitHub Release tarball asset.

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

`mise run ci` exercises formatting, lint, typecheck, tests, build, and the install smoke. The install smoke now validates the shared release tarball packer plus the guaranteed tarball install route before any publish step runs.

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

## Cut the release commit and tag

The recommended maintainer flow is to use npm's built-in version command rather than editing `package.json` and creating a matching tag separately:

```bash
npm version patch -m "chore(release): %s"
# or: npm version minor -m "chore(release): %s"
# or: npm version major -m "chore(release): %s"
```

That updates `package.json` (and lockfiles if present), creates the release commit, and creates the matching git tag in one step.
After that, push the commit and tag together:

```bash
git push origin HEAD --follow-tags
```

If you prefer to choose the exact version yourself, you can also run `npm version <X.Y.Z> -m "chore(release): %s"`.
The release workflow still validates that the checked-out `package.json` version matches the `vX.Y.Z` tag before publishing assets.

## Publish the GitHub Release

The hand-curated workflow lives at [`.github/workflows/release.yml`](../.github/workflows/release.yml).
Trigger it in one of two ways:

1. Push the release commit and tag created by `npm version`:

   ```bash
   git push origin HEAD --follow-tags
   ```

2. Or, if the release commit/tag already exists remotely, open the GitHub Actions UI, choose the **Release** workflow, and run it manually with the `tag` input set to `vX.Y.Z`.

The workflow will:

- resolve the release tag and check out that exact ref,
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
sha256sum -c "$DOWNLOAD_DIR/${RELEASE_TGZ}.sha256"

npm install -g --prefix "$INSTALL_PREFIX" "$DOWNLOAD_DIR/$RELEASE_TGZ"
"$INSTALL_PREFIX"/bin/agent-terminal version --json
"$INSTALL_PREFIX"/bin/agent-terminal --home "$AGENT_TERMINAL_HOME" doctor --json
```

For private releases, authenticated download is the expected verification route.
If you are testing a public release and the direct asset URL is reachable in your environment, you can also verify the hosted install path directly with `npm install -g <release-asset-url>`.

## Proof expectations

- Keep at least one current release-readiness bundle under `dogfood/`.
- Keep evergreen scenario bundles easy to discover from the dogfood catalog.
- When a change affects release, packaging, install, renderer, screenshot, wait, export, or review UX, include screenshots and recordings in the relevant proof bundle when feasible.

## Future npm publish seam

The release workflow intentionally stops at the GitHub Release asset.
A future npm-publish job should depend on `prepare-release`, consume the verified tarball and metadata JSON that job already emits, and publish without rebuilding the package.
Package name and registry decisions remain a separate follow-up because the current npm name is not settled.
