# Installation

`agent-tty` requires Node `>=24 <27`.
The recommended install path is the npm package `agent-tty`.
GitHub Release tarballs are the registry-independent fallback, and direct git dependency installs remain best-effort because they build from source.

After any install, verify the binary and local environment:

```bash
agent-tty version --json
agent-tty --home "$(mktemp -d)" doctor --json
```

If `doctor --json` reports a missing Playwright browser on a fresh machine, install [Chromium](#chromium).

## Chromium

Screenshots and WebM video need the Chromium build of the Playwright version that agent-tty uses.
For a global install or a mise install of a published release, look that version up and install its Chromium:

```bash
AGENT_TTY_VERSION=$(agent-tty version --json | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.cliVersion') &&
  PLAYWRIGHT_VERSION=$(npm view "agent-tty@${AGENT_TTY_VERSION}" dependencies.playwright) &&
  npx "playwright@${PLAYWRIGHT_VERSION}" install chromium
```

Unless the current folder is a project with that Playwright version installed, the install command prints a Playwright warning box that suggests `npm install` and a bare `npx playwright install`.
Ignore that box: the command already installs the right build.
A Playwright version looks only for the Chromium build that it was released with.
Outside a project, a bare `npx playwright install chromium` runs the newest Playwright, and its build can differ from the one that agent-tty looks for.
In a project-local install, `npx playwright install chromium` runs the Playwright of the project, which is the right one unless the project also depends on another Playwright version.
For that case and for a git install, whose snapshot can use a newer Playwright than the published release, take the version that `npm ls playwright` lists under `agent-tty` (add `-g` for a global install).

## npm

With npm 12, read [npm 12](#npm-12) first.

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

### npm 12

npm 12 does not run the install scripts of dependencies by default.
On Linux, `node-pty` builds its native module in an install script, so approve that script.
Without the approval, every `agent-tty` command fails with `Failed to load native module: pty.node`.

For a global install, add `--allow-scripts=node-pty`:

```bash
npm install -g --allow-scripts=node-pty agent-tty
```

npm 12 rejects that flag in a project-local install.
There, approve the script in the `package.json` of the project, then rebuild `node-pty`:

```bash
npm install agent-tty
npm approve-scripts node-pty
npm rebuild node-pty
```

A tarball file takes the same approval as the registry package.
npm 12 also refuses the release tarball URL and git sources by default.
For the [direct release asset install](#direct-release-asset-install), add `--allow-remote=root`:

```bash
npm install -g --allow-remote=root --allow-scripts=node-pty "$TARBALL_URL"
```

For the [git source install](#git-source-install), add `--allow-git=root`:

```bash
npm install -g --allow-git=root --allow-scripts=node-pty github:coder/agent-tty
```

To repair an install that already fails with that error, run the commands for its install type.

## mise

By default, mise does not run the install scripts of an npm tool's dependencies ([mise npm backend: build scripts](https://mise.jdx.dev/dev-tools/backends/npm.html#build-scripts-and-supply-chain-checks)).
On Linux, `node-pty` builds its native module in an install script, so approve that build when you add the tool:

```bash
mise use -g node@26 'npm:agent-tty[allow_builds=node-pty]'
mise exec -- agent-tty version --json
```

`node@26` makes Node 26 your global default, because mise does not add a Node version for an npm tool.
If your global Node already satisfies `>=24 <27`, omit `node@26`.
The build runs node-gyp, which needs Python, make, and a C++ compiler.
`mise exec --` runs the tool even when the mise shims are not on your `PATH`.
`allow_builds` works with the default installer of mise.
If you set `npm.package_manager` to `npm`, or `npm.shell_out` to `true`, the option needs npm 11.16 or later.
This section was tested with mise 2026.10.25 and 2026.11.5.

On Linux, an install without `allow_builds=node-pty` fails on every `agent-tty` command with `Failed to load native module: pty.node`.
To repair that install, run `mise uninstall npm:agent-tty`, then run the command above.
mise skips a tool that is already installed, so the option alone does not rebuild it.

mise asks for confirmation before it adds a package with few weekly downloads.
In a non-interactive shell, mise cannot ask, and it refuses the package unless you approve it.
To approve only agent-tty, add `allow_low_downloads=true` to the options, as in `'npm:agent-tty[allow_builds=node-pty,allow_low_downloads=true]'`.

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
pnpm install --frozen-lockfile
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
