# Installation

`agent-tty` requires Node `>=24 <26`.
The recommended install path is the npm package `agent-tty`.
GitHub Release tarballs are the registry-independent fallback, and direct git dependency installs remain best-effort because they build from source.

After any install, verify the binary and local environment:

```bash
agent-tty version --json
agent-tty --home "$(mktemp -d)" doctor --json
```

If `doctor --json` reports a missing Playwright browser cache on a fresh machine, run:

```bash
npx playwright install chromium
```

## npm

### Global install

```bash
npm install -g agent-tty
agent-tty version --json
agent-tty --home "$(mktemp -d)" doctor --json
```

For automation, pin an exact version:

```bash
PACKAGE_VERSION=<version>
npm install -g "agent-tty@${PACKAGE_VERSION}"
agent-tty version --json
```

To follow a prerelease channel, use a dist-tag such as `@beta` or `@rc`:

```bash
npm install -g agent-tty@beta
```

### Project-local install

```bash
npm install agent-tty
./node_modules/.bin/agent-tty version --json
```

With an exact version:

```bash
PACKAGE_VERSION=<version>
npm install "agent-tty@${PACKAGE_VERSION}"
./node_modules/.bin/agent-tty version --json
```

## GitHub Release Tarballs

### Direct release asset install

```bash
VERSION=<version>
RELEASE_TAG="v${VERSION}"
RELEASE_TGZ="agent-tty-${VERSION}.tgz"
TARBALL_URL="https://github.com/coder/agent-tty/releases/download/${RELEASE_TAG}/${RELEASE_TGZ}"

npm install -g "$TARBALL_URL"
agent-tty version --json
```

### Authenticated or private release install

```bash
VERSION=<version>
RELEASE_TAG="v${VERSION}"
RELEASE_TGZ="agent-tty-${VERSION}.tgz"

gh release download "$RELEASE_TAG" --repo coder/agent-tty --pattern "$RELEASE_TGZ"
npm install -g "./$RELEASE_TGZ"
agent-tty version --json
agent-tty --home "$(mktemp -d)" doctor --json
```

### Project-local tarball install

```bash
VERSION=<version>
RELEASE_TGZ="./agent-tty-${VERSION}.tgz"

npm install "$RELEASE_TGZ"
./node_modules/.bin/agent-tty version --json
```

## Local Tarball From Source

When you need a deterministic local artifact before publishing a GitHub Release, build a tarball from a checkout:

```bash
TARBALL_DIR=$(mktemp -d)
npm ci
npm run pack:private -- --pack-destination "$TARBALL_DIR"

INSTALL_PREFIX=$(mktemp -d)
npm install -g --prefix "$INSTALL_PREFIX" "$TARBALL_DIR"/*.tgz
"$INSTALL_PREFIX"/bin/agent-tty version --json
"$INSTALL_PREFIX"/bin/agent-tty --home "$(mktemp -d)" doctor --json
```

`npm run pack:private` rebuilds `dist/` before packing.
Release automation uses `npm run pack:release` after the CI-quality build step so GitHub Releases and npm publishing reuse the same verified tarball plus checksum.

## Git Source Install

```bash
npm install -g github:coder/agent-tty
agent-tty version --json
```

Git installs run npm's `prepare` hook and build from source.
Use this only when you explicitly want the latest default-branch snapshot and your npm/git-dependency environment can build native dependencies such as `node-pty`.

If your shell setup injects `mise activate` or another trust-checked tool into npm lifecycle subprocesses, trust the checkout path first or prefer the npm package or release tarball route.
