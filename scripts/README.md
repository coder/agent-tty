# scripts

## Overview

Plain Node `.mjs` scripts for the build, packaging and install-smoke steps. They run with `node` and do not import the TypeScript build output. `smoke-install.mjs` with `--skip-build` still packs the existing `dist/` and asserts that its files are present. `copy-renderer-assets.mjs` gives the reason in a comment: it runs after `tsc` as part of `npm run build`. Release CI and the `ci` mise chain call these scripts through package.json scripts.

## Interface

- `copy-renderer-assets.mjs`: takes no arguments. Copies `src/renderer/ghosttyWeb/assets` to `dist/renderer/ghosttyWeb/assets`. Caller: the package.json `build` script, after `tsc -p tsconfig.build.json`. [copy-renderer-assets.mjs:main]
- `pack-release.mjs`: flags `--build`, `--pack-destination <dir>` (default: the project root) and `--metadata-file <path>`. Runs `npm pack`, writes a `.sha256` file next to the tarball, and prints package metadata JSON to stdout. Callers: the package.json `pack:release` script, `.github/workflows/release.yml` and `docs/RELEASE-PROCESS.md`. [pack-release.mjs:parseCliArgs] [pack-release.mjs:main]
- `packRelease(options)`: the exported function behind `pack-release.mjs`. Returns `{ packageName, packageVersion, tarballFilename, tarballPath, tarballSizeBytes, checksumFilename, checksumPath, checksumSha256, npmShasum, packedPaths }`. `smoke-install.mjs` imports it. [pack-release.mjs:packRelease]
- `smoke-install.mjs`: flags `--skip-build` and `--exercise-git-install`. Packs the tarball, installs it into a temp prefix, and runs the installed CLI. With `--exercise-git-install` it also installs from a temporary git copy of the repo. Callers: the package.json `smoke:install` script and the mise task `install-smoke` (`npm run smoke:install -- --skip-build`), which `.github/workflows/ci.yml` runs. [smoke-install.mjs:supportedArgs] [smoke-install.mjs:verifyInstalledCli]
- `seed-canonical-manifest.mjs`: `node ./scripts/seed-canonical-manifest.mjs <bundle-dir> < list.txt`, where each stdin line is `<relative-path>\t<description>`. Prints `{ artifacts: [{ path, description, sha256, bytes }] }` for a canonical `manifest.json`. Its header calls it a one-time helper. No package.json script, mise task or workflow calls it. [seed-canonical-manifest.mjs:main]

## Invariants

- `copy-renderer-assets.mjs` throws when the source or the destination is not a directory, and sets `process.exitCode = 1`. [copy-renderer-assets.mjs:main]
- `parseCliArgs` throws on unknown arguments and on a value flag without a value. [pack-release.mjs:parseCliArgs]
- `packRelease` asserts that `npm pack --json` returns exactly one entry whose name and version match `package.json`, and that the tarball is a non-empty regular file. The checksum file holds `<sha256>  <tarball filename>`. [pack-release.mjs:packRelease]
- `sanitizeInheritedPath` removes `node_modules/.bin` and `node-gyp-bin` entries from `PATH` and asserts that one entry remains. [pack-release.mjs:sanitizeInheritedPath]
- `smoke-install.mjs` asserts on unsupported arguments. The pack and the install must contain `dist/cli/main.js`, `dist/index.js`, `dist/index.d.ts`, `skills/agent-tty/SKILL.md` and every renderer asset under `dist/renderer/ghosttyWeb/assets/`. [smoke-install.mjs:supportedArgs] [smoke-install.mjs:getRequiredPackPaths]
- `verifyInstalledCli` asserts that `version --json` reports the `package.json` version and that `--home <tmp> doctor --json` returns `ok: true`. [smoke-install.mjs:verifyInstalledCli]
- A failed git install passes only when the output matches a known node-pty caveat (`TAR_ENTRY_ERROR`, `spawn sh ENOENT`, `uv_cwd` and similar). Any other failure throws. [smoke-install.mjs:isKnownGitInstallCaveat]
- `seed-canonical-manifest.mjs` exits 1 when `<bundle-dir>` is missing or a listed path is not a regular file. It skips blank lines, `#` lines and lines without a tab. [seed-canonical-manifest.mjs:main]

## Side Effects

- `copy-renderer-assets.mjs` writes into `dist/` with `fs/promises` `mkdir` and recursive `cp`. [copy-renderer-assets.mjs:main]
- `pack-release.mjs` spawns `npm` with `spawnSync` (`npm run build` with `--build`, then `npm pack --json --ignore-scripts`). It creates the pack destination and the metadata file's directory with `mkdir`. It writes the `.sha256` file and the optional metadata file with `fs/promises.writeFile`. It reads `PATH`, `HOME`, `npm_config_cache`, `npm_execpath` and `MISE_TRUSTED_CONFIG_PATHS`. For the child it replaces `PATH` with the sanitized value, adds the npm cache, the project root and the OS temp folder to `MISE_TRUSTED_CONFIG_PATHS`, and sets the npm audit, fund and update-notifier settings to `false`. [pack-release.mjs:runNpm] [pack-release.mjs:getDefaultEnv] [pack-release.mjs:getTrustedConfigPaths] [pack-release.mjs:packRelease]
- `smoke-install.mjs` without `--skip-build` calls `packRelease` with `build: true`, which runs `npm run build` in the repo and rewrites `dist/`. [smoke-install.mjs] [pack-release.mjs:packRelease]
- `smoke-install.mjs` creates `$TMPDIR/agent-tty-install-smoke-*` with `mkdtemp` and removes it in a `finally` block. It runs `npm install -g --prefix <tmp>` and the installed `agent-tty` binary with an isolated `--home`. With `--exercise-git-install` it copies the repo and runs `git init`, `git add` and `git commit` in the copy. [smoke-install.mjs:verifyInstalledCli] [smoke-install.mjs:createGitInstallSource]
- `seed-canonical-manifest.mjs` reads stdin, hashes each file with `createReadStream`, writes JSON to stdout, and calls `process.exit(1)` for usage errors and non-regular files. Other errors, such as a missing listed path or a hash failure, reject the top-level `await main()` without `process.exit`. [seed-canonical-manifest.mjs:hashFile] [seed-canonical-manifest.mjs:main]

## Verification

- No automated test covers this directory directly.
- Run: `npm run build` (runs `copy-renderer-assets.mjs`)
- Run: `npm run smoke:install` (runs `smoke-install.mjs`, which calls `packRelease` and rebuilds `dist/`)
