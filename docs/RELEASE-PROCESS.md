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

`mise run ci` exercises formatting, lint, typecheck, tests, build, and the install smoke. The install smoke validates the shared release tarball packer plus the required tarball install route before any publish step runs.

## Prepare the release asset locally (optional but recommended)

Use the same release packer that CI relies on:

```bash
RELEASE_DIR=$(mktemp -d)
npm run build
npm run pack:release -- --pack-destination "$RELEASE_DIR" --metadata-file "$RELEASE_DIR/package-metadata.json"
cat "$RELEASE_DIR/package-metadata.json"
sha256sum -c "$RELEASE_DIR"/*.tgz.sha256
```

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

Versions containing a hyphen, such as `-beta.0` or `-rc.0`, are published by the workflow as GitHub prereleases and published to the matching npm dist-tag (`beta`, `rc`, and so on).

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

## Publish the GitHub Release and npm package

The hand-curated workflow lives at [`.github/workflows/release.yml`](../.github/workflows/release.yml).
It triggers automatically on pushed `v*` tags, and it can also be rerun manually for an already-existing remote tag via the **Release** workflow's `tag` input.

The workflow will:

- resolve the release tag and check out that exact ref,
- verify the tagged commit is already reachable from the default branch,
- validate that the tag matches the `package.json` version,
- run `mise run ci`,
- pack the verified tarball with `npm run pack:release`,
- upload the tarball, checksum, and metadata JSON as workflow artifacts,
- create or update the GitHub Release with the `.tgz` and `.sha256` assets attached,
- and publish that same verified tarball to npm via trusted publishing on a GitHub-hosted runner.

Stable releases publish with npm's default `latest` dist-tag.
Prerelease versions publish with the prerelease identifier as the dist-tag, so `0.1.1-beta.0` publishes to the `beta` dist-tag and `0.1.1-rc.1` publishes to the `rc` dist-tag.

## Verify the published npm package

After the workflow succeeds, verify the exact npm package version before announcing the release:

```bash
PACKAGE_NAME='agent-tty'
PACKAGE_VERSION='<version>'
INSTALL_PREFIX=$(mktemp -d)
AGENT_TTY_HOME=$(mktemp -d)

npm view "$PACKAGE_NAME" dist-tags --json
npm install -g --prefix "$INSTALL_PREFIX" "$PACKAGE_NAME@$PACKAGE_VERSION"
"$INSTALL_PREFIX"/bin/agent-tty version --json
"$INSTALL_PREFIX"/bin/agent-tty --home "$AGENT_TTY_HOME" doctor --json
```

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

Also verify the hosted tarball fallback before announcing the release:

```bash
VERSION=<version>
RELEASE_TAG="v${VERSION}"
RELEASE_TGZ="agent-tty-${VERSION}.tgz"

DOWNLOAD_DIR=$(mktemp -d)
INSTALL_PREFIX=$(mktemp -d)
AGENT_TTY_HOME=$(mktemp -d)

gh release download "$RELEASE_TAG" --repo coder/agent-tty --dir "$DOWNLOAD_DIR" --pattern "$RELEASE_TGZ"
gh release download "$RELEASE_TAG" --repo coder/agent-tty --dir "$DOWNLOAD_DIR" --pattern "${RELEASE_TGZ}.sha256"
sha256sum -c "$DOWNLOAD_DIR/${RELEASE_TGZ}.sha256"

npm install -g --prefix "$INSTALL_PREFIX" "$DOWNLOAD_DIR/$RELEASE_TGZ"
"$INSTALL_PREFIX"/bin/agent-tty version --json
"$INSTALL_PREFIX"/bin/agent-tty --home "$AGENT_TTY_HOME" doctor --json
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
