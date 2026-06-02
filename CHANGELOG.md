# Changelog

## [Unreleased]

## Added

- `agent-tty dashboard`: a read-only, interactive Session Dashboard that lists your sessions and shows a live view of the selected one — watch what your agents are doing in their shells, e.g. in a tmux split. The Live View is produced by Event Log Follow (file-tail of `events.jsonl` → `libghostty-vt` `replayTo`/`snapshot`), so it reads the append-only Event Log as the source of truth and never queries the live host (ADR 0006). Master-detail UI with Tab-toggled focus (list select vs. Live View pan), 1:1 clip-top-left/letterbox plus a lossy block-glyph overview (`z`), an active/all scope toggle (`a`), and pin-on-exit (the watched session stays and freezes on its final screen with an exit badge). Requires the optional `libghostty-vt` renderer with no browser fallback, so `doctor` now reports a `dashboard` readiness capability. Interactive-only (no `--json`; fails fast on a non-interactive terminal); machine-readable session listing remains via `list --json` ([#113](https://github.com/coder/agent-tty/pull/113), closes [#109](https://github.com/coder/agent-tty/issues/109)).
- `inspect --json` now reports `host.cliVersion`, `host.rpcSocketPath`, `rendererRuntime.profile`, `rendererRuntime.booted`, `rendererRuntime.bootInFlight` (live mode), and `eventLogBytes` (both live and offline replay). All fields are optional schema additions; existing consumers are unaffected ([#104](https://github.com/coder/agent-tty/pull/104)).
- Canonical proof-bundle lock-down: a new `CanonicalBundleManifestSchema` requires `sha256` and `bytes` on every artifact, `npm run validate-bundle:canonical` (also wired through `mise run validate-bundles`) runs eight drift-detection rules plus catalog parity across the four canonical bundles, and the `linux-static` CI job now fails on bundle drift ([#104](https://github.com/coder/agent-tty/pull/104)).
- Hero Demo bundle (`dogfood/agent-uses-agent-tty/`) replaced with an external Outer Camera flow: VHS records real Codex (`gpt-5.5`) and Claude (`claude-opus-4-7`) TUIs while `agent-tty` produces the inner Neovim proof artifacts. A new `mise run demo:agent-uses-agent-tty` task regenerates and promotes the demo with pinned `vhs`/`ttyd`/`ffmpeg` ([#105](https://github.com/coder/agent-tty/pull/105)).
- Hero Demo video playback workflow: `mise run demo:agent-uses-agent-tty:upload-assets` prepares H.264 MP4 upload assets (with the curated thumbnail held as the opening frames so GitHub's natural first-frame poster shows the end-state), and `mise run demo:agent-uses-agent-tty:apply-video-urls` rewrites the inline `<video>` srcs in the root and bundle READMEs and refreshes the manifest. Full guidance lives in `dogfood/agent-uses-agent-tty/VIDEO_PLAYBACK.md` ([#106](https://github.com/coder/agent-tty/pull/106)).
- README rebuild with one-line value prop, badge row, hero GIF, a "Why not tmux/expect/asciinema/Playwright?" comparison table, a two-backend "How it works" section (`libghostty-vt` + `ghostty-web`), and an origin story. Adds `assets/hero.{gif,tape}` and a Playwright-rendered 1200×630 social card under `assets/social-preview.*` ([#108](https://github.com/coder/agent-tty/pull/108)).
- Session Dashboard planning docs: ADR 0006 (Event Log Follow + `libghostty-vt` backend), `docs/prd/session-dashboard/PRD.md`, and new glossary terms in `CONTEXT.md` (Session Dashboard, Live View, Event Log Follow) ([#110](https://github.com/coder/agent-tty/pull/110)).

## Changed

- `inspect` collects renderer state and the session snapshot in a single synchronous tick before awaiting, so concurrent RPC handlers cannot interleave a mutated renderer state with a stale session snapshot ([#104](https://github.com/coder/agent-tty/pull/104)).
- `mise` development toolchain refresh; ordinary CI remains credential-free and does not install the live-demo recorder tools ([#107](https://github.com/coder/agent-tty/pull/107)).

## Fixed

- Restored the empty `## [Unreleased]` heading on `main` after the v0.2.0 release-prep commit so the `Update Unreleased Changelog` workflow stops failing on every push. `docs/RELEASE-PROCESS.md` now documents the rename-and-insert rule that keeps both `[Unreleased]` and `[v<version>]` headings present after a release cut ([#103](https://github.com/coder/agent-tty/pull/103)).

## [v0.2.0] - 2026-05-13

### Added

- New non-rendered `run_complete` event in the canonical event log carrying `{ marker, inputRunSeq }`, so automation consumers can correlate `input_run` with completion without scanning rendered output ([#55](https://github.com/coder/agent-tty/pull/55), tracking [#21](https://github.com/coder/agent-tty/issues/21)).
- `release:prep` and `release:finalize` npm scripts plus pinned `release-it` config for an opinionated release-prep workflow that updates package version files, creates a single `release/<version>` commit, and tags `v${version}` from a clean, synced `main` without ever publishing or creating GitHub Releases ([#72](https://github.com/coder/agent-tty/pull/72)).
- "Agent Demo" section in the README and an evergreen `dogfood/agent-uses-agent-tty/` bundle that records Codex and Claude TUIs driving `nvim --clean` through `agent-tty`, with outer/inner WebMs, asciicasts, transcripts, thumbnails, and a `reproduce.sh` script ([#54](https://github.com/coder/agent-tty/pull/54)).
- `dogfood/issue-21-run-completion-clean/` verification bundle proving snapshots, screenshots, asciicasts, WebM, and the `output` event stream contain no completion-marker bytes while the public `run` envelope still exposes `marker`, `completed`, and `durationMs` ([#55](https://github.com/coder/agent-tty/pull/55)).
- AFK Triage maintainer flow under `.sandcastle/` that fans out Claude Code triage agents across `needs-triage` / active `needs-info` GitHub issues, each in its own per-issue Coder workspace on `dev.coder.com` with a real `coder/agent-tty` checkout, governed by `docs/adr/0004-afk-triage-apply-policy.md` and the AFK comment marker policy ([#86](https://github.com/coder/agent-tty/pull/86), [#89](https://github.com/coder/agent-tty/pull/89)).

### Changed

- `run --wait` no longer leaks its internal completion marker into rendered artifacts. Completion is signaled via an APC sentinel consumed by the host PTY ingestion path before `output` events are appended, with a defensive scrub for any echoed `printf` postamble. Waits resolve on the new `run_complete` event instead of polling rendered snapshots for marker text. The public `run` JSON envelope is unchanged ([#55](https://github.com/coder/agent-tty/pull/55), tracking [#21](https://github.com/coder/agent-tty/issues/21)).
- Asciicast export now explicitly skips non-rendered events (`input_text`, `input_paste`, `input_keys`, `input_run`, `run_complete`, `signal`, `exit`) so recordings only contain `o`, `r`, and `m` frames ([#55](https://github.com/coder/agent-tty/pull/55)).
- `wait --text` / `--regex` / `--screen-stable-ms` / `--cursor-row` / `--cursor-col` validation is centralized in a shared render-wait matcher used by both live host polling and CLI offline replay fallback. Invalid, unsafe (nested-quantifier), or out-of-range patterns are rejected locally with `INVALID_INPUT` before any RPC or offline replay snapshot work. Public `wait` JSON shapes and human output are unchanged ([#76](https://github.com/coder/agent-tty/pull/76)).
- Renderer dispose now uses a per-lifecycle `ResourceScope` for deterministic LIFO release of page, browser context, browser, and local server. Public `dispose()` remains best-effort and resolves successfully; individual cleanup failures are now surfaced through the logger as `warn` entries with `{ name, error }` instead of being silently swallowed. Concurrent artifact-manifest appends route through a generic `KeyedSerializer<string>` while preserving existing serialization semantics ([#83](https://github.com/coder/agent-tty/pull/83)).
- `AbortSignal` is now threaded through host-side `wait`, `waitForRender`, `run` completion, lifecycle polling, and `sendRpc`, with timers, sockets, and listeners registered against `ResourceScope`. The RPC server also aborts the per-request context when a client socket closes, so abandoned RPC requests release host resources promptly instead of running to timeout. A bounded 1s liveness probe on the existing RPC socket avoids indefinite hangs during host startup when a stale socket neither accepts nor rejects a connection promptly. Public JSON envelopes and protocol schemas are unchanged ([#94](https://github.com/coder/agent-tty/pull/94), fixes [#84](https://github.com/coder/agent-tty/issues/84)).
- The supported Node range is now `>=24.0.0 <27` and the project toolchain is pinned to Node 26.1.0. Playwright is bumped to `1.60.0`, which ships the upstream fix for the Node 26 `playwright install chromium` extraction hang ([microsoft/playwright#40724](https://github.com/microsoft/playwright/issues/40724)) that previously forced a Node 26 revert in [#91](https://github.com/coder/agent-tty/pull/91). CLI behavior and JSON contracts are unchanged ([#98](https://github.com/coder/agent-tty/pull/98)).
- Local and CI dependency bootstrap now uses [`aube`](https://github.com/endevco/aube): `mise run bootstrap` runs `aube exec playwright install chromium` and `mise run bootstrap-ci` runs `aube ci`. The `mise`-pinned `aube` was bumped to `1.10.4` (migrating from `pnpm` / `npm` lockfiles to `aube-lock.yaml`), and `pnpm.allowBuilds` permits native builds for `@coder/libghostty-vt-node`, `esbuild`, `fsevents`, `node-pty`, `@parcel/watcher`, and `msgpackr-extract` ([#51](https://github.com/coder/agent-tty/pull/51), [#57](https://github.com/coder/agent-tty/pull/57), [#73](https://github.com/coder/agent-tty/pull/73), [#91](https://github.com/coder/agent-tty/pull/91)).
- Internal session-status policy, event-log codec, snapshot capture, screenshot capture, command-target resolution, waited-run completion bookkeeping, and Zod result-validation parsing are centralized into shared modules. No CLI, protocol, JSON envelope, manifest entry, or `rendererBackend` reporting changes ([#67](https://github.com/coder/agent-tty/pull/67), [#68](https://github.com/coder/agent-tty/pull/68), [#69](https://github.com/coder/agent-tty/pull/69), [#70](https://github.com/coder/agent-tty/pull/70), [#75](https://github.com/coder/agent-tty/pull/75), [#78](https://github.com/coder/agent-tty/pull/78), [#93](https://github.com/coder/agent-tty/pull/93)).
- Repository tooling switched from ESLint / Prettier to Oxc: `npm run format` / `format:check` now invoke `oxfmt`, and `npm run lint` / `lint:fix` invoke `oxlint` plus `oxlint-tsgolint` for type-aware checks. CI and `mise` task names are unchanged ([#71](https://github.com/coder/agent-tty/pull/71)).

### Fixed

- Default-location screenshot PNGs, snapshot JSON files, and `record export` artifacts are now rolled back when the subsequent artifact-manifest append fails, so a manifest-validation failure no longer leaves an orphaned, unmanifested file under the session's `artifacts/` directory. Explicit `--out` paths supplied by the caller are preserved on failure because they belong to the user, not the session manifest ([#95](https://github.com/coder/agent-tty/pull/95), fixes [#79](https://github.com/coder/agent-tty/issues/79)).
- `EventLog.open` now closes the underlying file handle when validation (size-limit check or existing-content parsing) fails, preventing a file-descriptor leak on rejected session host startup ([#51](https://github.com/coder/agent-tty/pull/51)).
- `npm run release:prep` and `npm run release:finalize` now work on aube-only checkouts where `package-lock.json` does not exist. `readPackageVersions` / `assertPackageVersionsMatch` skip the lockfile-coherence assertions when `package-lock.json` is absent, and `release-prep.mjs` stages only `package.json` in that case. The npm-lockfile path is still fully supported when a `package-lock.json` is present. Without this fix, the documented release flow was broken after the `aube` migration in [#91](https://github.com/coder/agent-tty/pull/91).

### Notes

- `protocolVersion` in the `version` envelope intentionally stays at `0.1.0`. This release is additive over the `0.1.x` envelope contract and does not change the public JSON shape; only the package version moves to `0.2.0`.

## [v0.1.1-beta.4](https://github.com/coder/agent-tty/releases/tag/v0.1.1-beta.4) - 2026-04-25

### Added

- Selectable `libghostty-vt` renderer backend support with backend-selection plumbing for live commands, offline replay, screenshots, snapshots, waits, and WebM export, plus dogfood coverage for the fallback path (#42).
- Skills eval authoring and reporting DX, including workspace presets, reporter lifecycle hooks, token usage snapshots, and stronger statistical guidance for measuring skill changes (#33, #35, #36, #37).
- Communique-powered release changelog and GitHub Release note automation, locked `mise` tooling, and GitHub Actions workflow linting with `actionlint` and `zizmor` (#32, #39).
- Apache license and reorganized repository documentation for release, roadmap, design, dogfood, contributor, and maintainer workflows (#40, #41, #43).

### Changed

- The package engine range now allows Node 25 in addition to Node 24 (#39).
- Development dependency maintenance updated PostCSS (#44).

### Fixed

- `agent-tty --help` now points users at `agent-tty skills list` for bundled skill discovery (#38).
- Release workflows now authenticate protected branch fetches so private-repository release automation can read base/default branch refs (#45).
- Eval scoring, reporting, verifier calibration, and anti-pattern checks were hardened with additional unit coverage (#34, #36).

## [v0.1.1-beta.3](https://github.com/coder/agent-tty/releases/tag/v0.1.1-beta.3) - 2026-04-24

### Added

- Multi-skill runtime system with new `agent-tty skills list|get|path` subcommands, serving canonical skills from a packaged `skill-data/` directory, plus a new built-in `dogfood-tui` skill for TUI QA workflows (#28)

### Changed

- **Renamed the public CLI surface from `agent-terminal` to `agent-tty`**: npm package, binary, skill name, `AGENT_TTY_*` environment variables, default home at `~/.agent-tty`, and the GitHub repo now live at `coder/agent-tty` (#27)
- RPC sockets now use a short hashed path under `/tmp/agent-tty` so isolated temp homes don't exceed macOS Unix socket path limits (#29)
- `doctor` now uses the shared Playwright browser-cache resolver, reporting the correct `~/Library/Caches/ms-playwright` path on macOS (#29)
- `run` now writes executable shell input directly instead of using bracketed-paste control sequences (#29)

### Fixed

- Mux workspace hooks now trust the workspace-local `mise.toml` before running `mise install`/`bootstrap`, preventing new worktree setups from failing (#26)
- Darwin `node-pty` `spawn-helper` has its executable bit repaired at runtime, fixing PTY spawn failures on packaged macOS installs (#29)

### Removed

- `agent-tty skill` (singular) has been removed — use `agent-tty skills get agent-tty` instead (#28)

## [v0.1.1-beta.0](https://github.com/coder/agent-tty/releases/tag/v0.1.1-beta.0) - 2026-04-24

### Added

- Complete session control plane: `create`, `list`, `inspect`, `destroy`, `gc`, with per-session background host, PTY lifecycle, and append-only event log (#3, #5).
- Input commands: `type`, `paste`, `send-keys`, `resize`, `signal`, and a first-class `run` for robust in-session command execution with completion detection (#3, #14).
- Renderer-backed inspection: semantic `snapshot` (structured and `--format text`), deterministic `screenshot` with `reference-dark` / `reference-light` profiles, and `wait --text` / `--regex` / `--screen-stable-ms` / `--exit` / `--idle-ms` (#4).
- `record export --format asciicast` and `--format webm` for text and video replay artifacts, with post-exit offline replay of `snapshot`, `screenshot`, and exports from persisted event logs (#5).
- `doctor` health checks covering PTY spawn, home/socket/artifact writability, Playwright browser cache, home isolation, renderer/bundle assets, and capability reporting (#5, #12, #14).
- Public `agent-terminal` skill under `skills/agent-terminal/SKILL.md` with TanStack Intent integration, plus a top-level `agent-terminal skill` command that emits the packaged skill markdown (raw or `--json`) for just-in-time agent loading (#16, #22).
- Verified tarball install flow: new `pack:release` script, `smoke:install` coverage, and documented private/prerelease install guidance (#19).
- GitHub Release workflow (`prepare-release` + `publish-github-release`) that produces a validated `.tgz` with SHA-256 checksum and metadata artifact, with prerelease tag support and an ancestry guard that requires tagged commits to be reachable from the default branch (#23, #24).
- Bundled Nerd Font fallback so renderer-backed screenshots and WebM exports render glyph-heavy TUIs correctly out of the box (#11).

### Changed

- Artifact manifest now records `sha256`, byte size, render profile, and `recording` / `video` kinds for reviewable, deterministic export artifacts (#5).
- Renderer now resolves `PLAYWRIGHT_BROWSERS_PATH` from the host `HOME` so screenshots and WebM export work in isolated sessions without manual env overrides (#14).
- Repository documentation reorganized and an `AGENTS.md` contributor guide added (#6, #17).

### Fixed

- Release workflow accepts prerelease versions like `0.1.1-beta.0` / `0.1.1-rc.0` in version tests and tag validation (#24).
