# Changelog

## [Unreleased]

### Added

- New `run_complete` event in the canonical event log carrying `{ marker, inputRunSeq }`, so automation consumers can correlate `input_run` with completion without scanning rendered output ([#55](https://github.com/coder/agent-tty/pull/55), tracking [#21](https://github.com/coder/agent-tty/issues/21)).
- "Agent Demo" section in the README and an evergreen `dogfood/agent-uses-agent-tty/` bundle that records Codex and Claude TUIs driving `nvim --clean` through `agent-tty`, including outer/inner WebMs, asciicasts, transcripts, thumbnails, and a `reproduce.sh` script ([#54](https://github.com/coder/agent-tty/pull/54)).
- New `dogfood/issue-21-run-completion-clean/` verification bundle proving snapshots, screenshots, asciicasts, WebM, and the `output` event stream contain no completion-marker bytes while the public `run` envelope still exposes `marker`, `completed`, and `durationMs` ([#55](https://github.com/coder/agent-tty/pull/55)).
- `release:prep` and `release:finalize` npm scripts plus pinned `release-it` config for an opinionated release-prep workflow that updates package version files, creates a single `release/<version>` commit, and tags `v${version}` from clean, synced `main` without ever publishing or creating GitHub Releases ([#72](https://github.com/coder/agent-tty/pull/72)).

### Changed

- `run --wait` no longer leaks its internal completion marker into rendered artifacts. Completion is now signaled through an APC sentinel (`ESC _ agent-tty:run-complete:<marker> ESC \`) consumed by the host PTY ingestion path before `output` events are appended, with a defensive scrub for any echoed `printf` postamble. Waits resolve on the new `run_complete` event instead of polling rendered snapshots for marker text. The public `run` JSON envelope (`accepted`, `completed`, `timedOut`, `seq`, `durationMs`, `marker`) is unchanged ([#55](https://github.com/coder/agent-tty/pull/55), tracking [#21](https://github.com/coder/agent-tty/issues/21)).
- Asciicast export now explicitly skips non-rendered events (`input_text`, `input_paste`, `input_keys`, `input_run`, `run_complete`, `signal`, `exit`) so recordings only contain `o`, `r`, and `m` frames ([#55](https://github.com/coder/agent-tty/pull/55)).
- `wait --text` / `--regex` / `--screen-stable-ms` / `--cursor-row` / `--cursor-col` validation is now centralized in a shared render-wait matcher used by both live host polling and CLI offline replay fallback. Invalid, unsafe (nested-quantifier), or out-of-range patterns are rejected locally with `INVALID_INPUT` before any RPC or offline replay snapshot work. Public `wait` JSON result shapes, offline-stability fallback shape, and human output are unchanged ([#76](https://github.com/coder/agent-tty/pull/76)).
- Local and CI dependency bootstrap now uses [`aube`](https://github.com/endevco/aube): `mise run bootstrap` runs `aube exec playwright install chromium`, `mise run bootstrap-ci` runs `aube ci`, and the documented fallback (when `mise` is unavailable) is `aube exec playwright install chromium`. The `packageManager` field is set to `aube@1.2.0`, the pinned `mise` tool was bumped to `aube@1.4.0`, and a new `pnpm.allowBuilds` allow-list permits native builds for `@coder/libghostty-vt-node`, `esbuild`, `fsevents`, and `node-pty` ([#51](https://github.com/coder/agent-tty/pull/51), [#57](https://github.com/coder/agent-tty/pull/57), [#73](https://github.com/coder/agent-tty/pull/73)).
- Session-status policy is now centralized in a single module that classifies every `SessionStatus` as active, terminal, commandable, live-host eligible, offline-replay eligible, collectable, and destroyed; lifecycle, inspect, gc, wait, host, and command-state checks share the same predicates. CLI JSON, protocol schemas, event-log behavior, and artifact formats are unchanged ([#67](https://github.com/coder/agent-tty/pull/67)).
- Persisted event-log validation, JSONL parsing, and contiguous-sequence checks for live hydration, offline replay, and `record export` now flow through a shared codec at `src/storage/eventLogCodec.ts`. Validation errors use neutral event-log wording; missing-log policy remains caller-specific (offline replay treats missing logs as empty; `record export` still surfaces missing logs as an error) ([#68](https://github.com/coder/agent-tty/pull/68)).
- Snapshot result construction and artifact persistence are now shared between live host RPCs and offline replay through `src/snapshot/capture.ts`. Snapshot artifact filenames, JSON formatting (two-space indent + trailing newline), manifest metadata, and `rendererBackend` reporting are unchanged ([#69](https://github.com/coder/agent-tty/pull/69)).
- Waited-run completion bookkeeping (sentinel scanning, postamble sanitization, waiter resolution, timeout, exit, `run_complete` appends) moved out of `hostMain` into a dedicated `RunCompletionCoordinator`. No public CLI, protocol, or event-log changes ([#70](https://github.com/coder/agent-tty/pull/70)).
- `type`, `paste`, `send-keys`, `mark`, `resize`, `signal`, and `run` now use a shared `resolveCommandTarget()` helper for session lookup, manifest read, commandable-status check, and socket-path resolution. `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `SESSION_ALREADY_DESTROYED`, and per-command validation order are preserved ([#75](https://github.com/coder/agent-tty/pull/75)).
- Refreshed contributor and agent guidance in `AGENTS.md` with an outcome-first operating contract, validation guidance, and grouped project invariants ([#46](https://github.com/coder/agent-tty/pull/46)). Added in-repo agent skills under `.agents/skills/` (`diagnose`, `tdd`, `triage`, `improve-codebase-architecture`, `grill-with-docs`, `to-issues`, `to-prd`) plus matching links from `.claude/skills/` and `.mux/skills/` ([#65](https://github.com/coder/agent-tty/pull/65)).

### Fixed

- `EventLog.open` now closes the underlying file handle when validation (size-limit check or existing-content parsing) fails, preventing a file-descriptor leak on rejected session host startup ([#51](https://github.com/coder/agent-tty/pull/51)).

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
