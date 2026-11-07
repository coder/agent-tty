# Changelog

## [Unreleased]

## [0.6.0] - 2026-11-07

### Added

- `record diff <a> <b>` offline command computes an LCS line diff between two sessions (or one session at two seqs) with structured `{ identical, a, b, diff }` JSON output and a unified human-mode view ([#170](https://github.com/coder/agent-tty/pull/170)). `--at-seq-a`/`--at-seq-b` now accept `-1` for an empty event log ([#300](https://github.com/coder/agent-tty/pull/300)).
- `record export --format svg [--animate]` writes browserless, byte-deterministic SVGs with embedded JetBrains Mono and optional symbol/math font subsets; still exports hold the final frame, animated exports use SMIL with recorded event timing ([#171](https://github.com/coder/agent-tty/pull/171)). A clock that stepped backward now fails only the animated form with a clear `EXPORT_ERROR` ([#349](https://github.com/coder/agent-tty/pull/349)).
- `mouse` CLI/RPC command and batch step for mode-aware native mouse input (press, release, drag, wheel) through the libghostty-vt backend, with `mouse-input` capability detection and `CAPABILITY_UNAVAILABLE` (exit 12) when the native package is missing ([#179](https://github.com/coder/agent-tty/pull/179)).
- `wait --scope cursor-line` matches `--text`/`--regex` only against the cursor row, so prompt waits like `--regex 'READY> $' --scope cursor-line` cannot be fooled by the echoed command line ([#169](https://github.com/coder/agent-tty/pull/169)).
- `screenshot --out <path>` writes the PNG to a chosen path, matching `record export --out` semantics ([#241](https://github.com/coder/agent-tty/pull/241)). Both commands now create missing parent folders like `mkdir -p` while still refusing any path inside the Home's `sessions/` folder ([#279](https://github.com/coder/agent-tty/pull/279), [#290](https://github.com/coder/agent-tty/pull/290)).
- `screenshot --json` reports `missingGlyphs` and `missingGlyphsTruncated` for codepoints that render as `.notdef` boxes, judged per-face and across the full built-in font stack ([#240](https://github.com/coder/agent-tty/pull/240), [#278](https://github.com/coder/agent-tty/pull/278)). `record export --format webm` reports the same fields for painted frames ([#278](https://github.com/coder/agent-tty/pull/278)).
- Bundled Noto Sans Symbols 2 and Noto Sans Math subsets extend the built-in font stack by ~4761 codepoints without overriding host color emoji; built-in render profile hash changes accordingly ([#278](https://github.com/coder/agent-tty/pull/278)).
- `inspect` reports `eventLogStop: { reason, seq }` and `WAIT_TIMEOUT`/`REPLAY_ERROR` messages name the stop (`byte limit`, `event limit`, or `reason unknown`) when the event log hit its size limit ([#357](https://github.com/coder/agent-tty/pull/357)).
- Spawned processes now see `AGENT_TTY_ACTIVE=true` and `AGENT_TTY_SESSION_ID=<id>` in their environment ([#166](https://github.com/coder/agent-tty/pull/166)). Session-less PTYs (e.g. `doctor`'s probe) strip inherited values instead of leaking them ([#178](https://github.com/coder/agent-tty/pull/178)).
- PTY answers XTGETTCAP (`Tc`, `RGB`, `setrgbf`, `setrgbb`) and declines DECRQSS SGR, so Neovim detects truecolor even under `env -i` ([#271](https://github.com/coder/agent-tty/pull/271)). `COLORTERM=truecolor` is set by default in every session, overridable via `--env` ([#231](https://github.com/coder/agent-tty/pull/231)).

### Changed

- **Build: migrated from aube to pnpm** (`pnpm@10.34.5`), so Dependabot updates work again. Package resolutions are byte-identical; `mise run bootstrap` now runs `pnpm install && pnpm exec playwright install chromium` ([#176](https://github.com/coder/agent-tty/pull/176)).
- `wait` without `--timeout` now defaults to 30 s (down from 600 s) and `wait --help` shows the default; `--timeout 0` still waits without a limit ([#236](https://github.com/coder/agent-tty/pull/236)). Batch `wait` steps default to the same 30 s ([#250](https://github.com/coder/agent-tty/pull/250)).
- Timed-out waits return a `WAIT_TIMEOUT` error envelope with `ok: false`, `error.code: WAIT_TIMEOUT`, and the wait result carried under `result`; exit code stays 11 ([#232](https://github.com/coder/agent-tty/pull/232)). Human-mode messages name the effective timeout ([#273](https://github.com/coder/agent-tty/pull/273)). A render wait that keeps failing stops with the renderer's own error instead of reporting `WAIT_TIMEOUT` ([#301](https://github.com/coder/agent-tty/pull/301)).
- `wait` rejects a `--screen-stable-ms` or `--idle-ms` window that cannot finish within the effective timeout with `INVALID_DURATION` at parse time, instead of waiting out the timeout ([#277](https://github.com/coder/agent-tty/pull/277)).
- Per-session RPC sockets live under `/tmp/agent-tty-<uid>/` with a verified `0700` root, so another user cannot squat on the Home socket folder. CLIs from older versions fall back to the legacy path for one release ([#288](https://github.com/coder/agent-tty/pull/288)).
- RPC responses are accepted up to 64 MiB (success paths), lifting the cap on `snapshot --include-cells` for large grids; oversize successes report `PROTOCOL_ERROR` instead of `RPC_ERROR` ([#320](https://github.com/coder/agent-tty/pull/320), [#322](https://github.com/coder/agent-tty/pull/322)). Live snapshot RPC timeout extended to 60 s to match replay cost at large sizes.
- Live `snapshot`/`screenshot` replay the event log in bounded slices and send periodic keep-alive bytes, so large logs no longer trip the 5 s socket inactivity timeout ([#359](https://github.com/coder/agent-tty/pull/359)).
- Captures at the same seq keep earlier artifact files via `link`-based publication with `-<n>` suffixes when bytes differ, so a failed repeat capture can no longer delete the earlier file ([#191](https://github.com/coder/agent-tty/pull/191)).
- `record export --format webm` paces output using a schedule built from recorded gaps, so bursts no longer play back as a single late frame ([#285](https://github.com/coder/agent-tty/pull/285)).
- Empty event logs are a valid state: `snapshot`, `screenshot`, render `wait`, asciicast and WebM exports all return `capturedAtSeq: -1` with the expected blank output instead of failing ([#235](https://github.com/coder/agent-tty/pull/235), [#270](https://github.com/coder/agent-tty/pull/270)).

### Fixed

- Session lifecycle hardened across `create`, `destroy`, `reconcile` and `gc`, closing races that could corrupt sessions when multiple agents shared one Home ([#181](https://github.com/coder/agent-tty/pull/181), [#200](https://github.com/coder/agent-tty/pull/200), [#201](https://github.com/coder/agent-tty/pull/201), [#216](https://github.com/coder/agent-tty/pull/216), [#239](https://github.com/coder/agent-tty/pull/239), [#302](https://github.com/coder/agent-tty/pull/302), [#303](https://github.com/coder/agent-tty/pull/303)).
- `create` now stops its host (and names the session in every error envelope via `error.details.sessionId`) when any readiness-wait error fires, writes a `create-failed` marker the host watches for, and waits for a slow host as long as that host process lives (up to a 30 s hard deadline on the monotonic clock) ([#247](https://github.com/coder/agent-tty/pull/247), [#294](https://github.com/coder/agent-tty/pull/294), [#312](https://github.com/coder/agent-tty/pull/312), [#324](https://github.com/coder/agent-tty/pull/324), [#362](https://github.com/coder/agent-tty/pull/362)).
- `destroy` now stops the program's full process group with SIGKILL after a 2 s grace, forwards SIGINT/SIGTERM to its re-run copy (exits 130/143), finds in-shell destroys off-Linux by controlling terminal, and `destroy --force` ends sessions whose program group is unreadable (EACCES, EIO, etc.) ([#201](https://github.com/coder/agent-tty/pull/201), [#216](https://github.com/coder/agent-tty/pull/216), [#246](https://github.com/coder/agent-tty/pull/246), [#281](https://github.com/coder/agent-tty/pull/281), [#327](https://github.com/coder/agent-tty/pull/327)).
- `gc` keeps a session whose program group still runs (new skip reason names `destroy`) and removes it only when agent-tty can prove the group dead, including fork-chain and zombie-only scans ([#302](https://github.com/coder/agent-tty/pull/302), [#326](https://github.com/coder/agent-tty/pull/326)).
- Event log stops at its 50 MB / 250 000-entry limits and writes one `marker` record naming the cause, so hosts no longer crash on oversized logs; later commands name the stop in their error messages ([#340](https://github.com/coder/agent-tty/pull/340), [#357](https://github.com/coder/agent-tty/pull/357)).
- Artifact manifest writes are serialized through a per-session lock file, so concurrent captures no longer drop entries ([#282](https://github.com/coder/agent-tty/pull/282)). A failed `screenshot --out` copy now rolls back its in-session entry, and `record export` identifies its temp file so repeat writes to one path keep the latest entry's bytes ([#300](https://github.com/coder/agent-tty/pull/300), [#321](https://github.com/coder/agent-tty/pull/321)).
- `--out` writes re-check the parent folder's device and inode just before the rename, refuse parents without search permission, and name the swapped folder in the `EXPORT_ERROR` ([#279](https://github.com/coder/agent-tty/pull/279)).
- Screenshots now actually honor `--show-cursor`/`--hide-cursor` (previous behavior drew the cursor regardless) ([#289](https://github.com/coder/agent-tty/pull/289)).
- `screenshot --json` of a session that printed nothing no longer draws a block cursor at (0,0) ([#235](https://github.com/coder/agent-tty/pull/235), [#289](https://github.com/coder/agent-tty/pull/289)).
- Mouse same-cell motion stays deduplicated after program output and after renderer swaps; waited `run` input is now logged in PTY order ([#234](https://github.com/coder/agent-tty/pull/234), [#293](https://github.com/coder/agent-tty/pull/293)). Depends on bumping `@coder/libghostty-vt-node` to 0.1.0-beta.7, which also moves the linux-x64 prebuild to the x86-64 baseline (pre-beta.5 required AVX-512).
- `--json` always emits exactly one envelope on stdout: unexpected errors become `INTERNAL_ERROR` (and exit immediately once flushed), Commander usage errors emit `INVALID_INPUT`, invalid session IDs return `INVALID_SESSION_ID` across 17 commands, and config read/parse errors are typed as `STORAGE_READ_ERROR`/`INVALID_INPUT` ([#237](https://github.com/coder/agent-tty/pull/237), [#287](https://github.com/coder/agent-tty/pull/287)).
- CLI warns on stderr when running on an unsupported Node (checked against `engines.node`), and `doctor` reports the full `>=24.0.0 <27` range ([#245](https://github.com/coder/agent-tty/pull/245)).
- Host RPC errors now carry `CliError.details` across the wire (bounded to serializable, < 65 536 chars), and oversized error responses truncate the message with `[message truncated]` instead of crashing the host ([#313](https://github.com/coder/agent-tty/pull/313), [#315](https://github.com/coder/agent-tty/pull/315), [#319](https://github.com/coder/agent-tty/pull/319)).
- Home registry read drops only invalid entries instead of discarding every Home when one entry is corrupt ([#186](https://github.com/coder/agent-tty/pull/186)).
- First `create` in a Home behind a symlink no longer fails: CLI and host now canonicalize the path the same way before it exists ([#210](https://github.com/coder/agent-tty/pull/210)).
- `_host` tool hardening: bundle validation rejects canonical symlink escapes and hero-demo promotion leak-checks before writing ([#187](https://github.com/coder/agent-tty/pull/187)).
- Many smaller host and storage fixes around socket cleanup, destroy timing, shutdown races, Windows late-host handling, and APFS EINVAL mapping to `SESSION_NOT_FOUND`.

### Breaking Changes

- `agent-tty wait` default timeout changed from 600 s to 30 s. Scripts that relied on the old default must pass `--timeout <ms>` or `--timeout 0`. Batch `wait` steps default to 30 s likewise ([#236](https://github.com/coder/agent-tty/pull/236), [#250](https://github.com/coder/agent-tty/pull/250)).
- Timed-out `wait` JSON envelope: `ok` is now `false` with `error.code: "WAIT_TIMEOUT"`. The wait result is still present under `result` (preserving `.result.timedOut`, `.result.matched`, `.result.capturedAtSeq`). Exit code remains 11 ([#232](https://github.com/coder/agent-tty/pull/232)).
- Per-session sockets moved to `/tmp/agent-tty-<uid>/`. Running hosts started by 0.5.0 remain reachable via a one-release legacy-path fallback; destroy sessions before downgrading ([#288](https://github.com/coder/agent-tty/pull/288)).
- `screenshot`/`record export --out` into a path inside the Home's `sessions/` folder is now refused with `EXPORT_ERROR` ([#241](https://github.com/coder/agent-tty/pull/241)).
- `capturedAtSeq` can now be `-1` across snapshot, screenshot, wait, record export, record diff, batch results and the artifact manifest. Clients that asserted `capturedAtSeq >= 0` must accept `-1` ([#235](https://github.com/coder/agent-tty/pull/235), [#270](https://github.com/coder/agent-tty/pull/270)).
- Built-in render profile hash changed because Noto Sans Symbols 2 and Noto Sans Math joined the default font stack. Byte-identical PNG comparisons against prior releases will differ for any screen containing covered glyphs ([#278](https://github.com/coder/agent-tty/pull/278)).
- Inherited `COLORTERM` from the outer shell no longer reaches sessions; use `--env COLORTERM=<value>` to override ([#231](https://github.com/coder/agent-tty/pull/231)).

### New Contributors

* @prmartinow made their first contribution in [#166](https://github.com/coder/agent-tty/pull/166)
* @pmarreck made their first contribution in [#179](https://github.com/coder/agent-tty/pull/179)

## [0.5.0] - 2026-06-23

### Added

- Default semantic actions (`wait`, `snapshot`, screen hash, batch render-wait, host replay) now use `libghostty-vt` when the optional native package is installed, with automatic `ghostty-web` fallback otherwise. Visual artifacts (`screenshot`, `record export --format webm`) still default to `ghostty-web`. Explicit `--renderer`, `AGENT_TTY_RENDERER`, and `config.json.defaultRenderer` overrides keep precedence. ([#157](https://github.com/coder/agent-tty/pull/157))
- The host now answers terminal capability queries on the live PTY: **OSC 10** (foreground), **OSC 11** (background), and **DSR `ESC[5n`** (status). Eliminates the Neovim 0.12+ `E1568` startup warning leaking into captures. Replies are written as child input and are not appended to the event log, so snapshots, screenshots, and recordings are unaffected. ([#163](https://github.com/coder/agent-tty/pull/163))
- Dashboard: pressing **Enter** in a maximized view now restores it, mirroring **Esc**. Footer hint updated to `esc/⏎ restore`. ([#153](https://github.com/coder/agent-tty/pull/153))
- CLI exit-code contract documented in `docs/USAGE.md` (full `0`–`11` mapping plus `batch` fail-fast / `--keep-going` semantics), with a new top-of-README anchor nav and grouped command-surface table. ([#150](https://github.com/coder/agent-tty/pull/150))

### Changed

- **Standalone `wait` now exits `11` (`WAIT_TIMEOUT`) on timeout** while still emitting the existing `ok: true` envelope with `timedOut: true` / `matched: false`. Makes shell composition fail closed (`agent-tty wait … && next-step`). Closes [#151](https://github.com/coder/agent-tty/issues/151). ([#165](https://github.com/coder/agent-tty/pull/165))
- Local-state hardening: the per-session RPC socket directory is now `0o700`, the socket file `0o600`, and persisted state files (session manifests, Home Registry) `0o600`, regardless of umask. The Home and session directories are also locked to `0o700` and `events.jsonl` to `0o600`, so the full terminal byte stream (which can contain secrets) is no longer world-readable. ([#158](https://github.com/coder/agent-tty/pull/158), [#161](https://github.com/coder/agent-tty/pull/161))
- Snapshot/wait performance: dropped a redundant deep clone of the event log in the `libghostty-vt` backend and skipped per-event Zod re-validation on the trusted live-host replay path (seq ordering is still enforced). ([#161](https://github.com/coder/agent-tty/pull/161))
- Dependency audit gate: `aube audit --audit-level high` now runs in CI; transitive `esbuild`, `vite`, `ws`, and `brace-expansion` advisories were cleared via `package.json` overrides. ([#158](https://github.com/coder/agent-tty/pull/158))
- Pre-1.0 versioning: `feat:` commits now bump the **minor** version (e.g. `0.4.x → 0.5.0`) instead of being flattened into patches. Breaking changes still bump minor; `1.0.0` remains an explicit `Release-As:` decision. ([#152](https://github.com/coder/agent-tty/pull/152))

### Fixed

- Dashboard redraws immediately on terminal/tmux pane resize. Previously, panes kept stale geometry for up to ~1.5s on idle sessions; now they track the new size on the first post-resize frame. Also removes a latent `NaN`-width path on non-TTY stdout. ([#162](https://github.com/coder/agent-tty/pull/162))
- The standing release-please PR is now opened on `release-please--branches--main` (the package-name component suffix is gone). ([#147](https://github.com/coder/agent-tty/pull/147))
- The README status-version badge is now wired into release-please `extra-files` and bumps with each release PR. ([#156](https://github.com/coder/agent-tty/pull/156))

### Docs

- README tagline mentions `agent-browser` alongside Playwright. ([#155](https://github.com/coder/agent-tty/pull/155))
- `RELEASE.md` support contract reworded to be version-agnostic so release-please bumps no longer stale it. ([#158](https://github.com/coder/agent-tty/pull/158))
- `dogfood-tui` skill clarifies when to use live terminal evidence vs source/tests, and that text snapshots are not authoritative for CJK/emoji column-width questions. ([#164](https://github.com/coder/agent-tty/pull/164))

### CI

- PR titles are validated as Conventional Commits via `amannn/action-semantic-pull-request`, so the squash-merge subject that lands on `main` always parses cleanly for release-please. ([#154](https://github.com/coder/agent-tty/pull/154))

## [0.4.3] - 2026-06-12

### Fixed

- Dispatch the `release.yml` pipeline with `--ref "$tag"` so the run is attributed to the tag ref instead of `main`, restoring tag-pinned OIDC claims for npm trusted publishing and provenance ([#145](https://github.com/coder/agent-tty/pull/145) by @ThomasK33).

## [0.4.2] - 2026-06-12

### Changed

- Releases are now driven by release-please with Communique authoring the changelog section. CHANGELOG headings for new releases drop the `v` prefix (e.g. `## [0.4.2] - ...`); the historical `## [v0.4.1]` entry is left untouched. No CLI, JSON envelope, snapshot, recording, or export behavior changes ([#143](https://github.com/coder/agent-tty/pull/143) by @ThomasK33).

## [v0.4.1] - 2026-06-12

### Added

- `agent-tty ls` is now a short alias for `agent-tty list`. Like the `d`→`dashboard` alias, it is an explicit alias (not prefix matching), so it resolves unambiguously to `list` and is unaffected by the other commands ([#135](https://github.com/coder/agent-tty/pull/135)).
- Dashboard Live View can now be maximized: press `Enter` from the session list or the focused Live View to expand the selected session's Live View to the full dashboard body (dropping the session list); `Esc` restores the split. Maximize is a modal layer that never mutates `focus`, so `Esc` returns to whatever was focused underneath. Panning (`↑/↓ h/j/k/l`) and the `z` Overview toggle keep working while maximized; the header, footer, and the same right edge are preserved across the toggle so the frame never shifts. `Tab`/`H`/`a` are inert in maximized mode so it reads as a distinct mode ([#136](https://github.com/coder/agent-tty/pull/136)).

### Changed

- `record export --format webm` now defaults to `--timing recorded`, so exported videos play back at the recorded wall-clock pace instead of the previous `accelerated` default that clamped every idle gap to 100ms and turned most interactive sessions into ~2s flash-by clips. `accelerated` and `max-speed` remain available as explicit opt-ins, and `accelerated` has been retuned for watchability: idle gaps now clamp to 400ms (was 100ms) and each frame holds at least 100ms (was 50ms). The CLI JSON envelope shape is unchanged — only the default value of `metadata.timingMode` differs when `--timing` is omitted ([#139](https://github.com/coder/agent-tty/pull/139)).

## [v0.4.0] - 2026-06-08

### Added

- `agent-tty batch <session-id>`: run an ordered sequence of input-and-`wait` steps against one session in a single invocation, supplied as a positional JSON array or `--file`. Each step is one verb (`type`, `paste`, `sendKeys`, `run`, or `wait`); every `wait` is anchored to a Wait Baseline (the Event Log sequence after the preceding input step) so it cannot match a stale screen the way a hand-written `run`/`wait`/`send-keys` loop can (ADR 0007). Fail-fast by default with a non-zero exit and a per-step `--json` envelope; `--keep-going` attempts every step. SIGINT/SIGTERM flushes a partial envelope (in-flight step `interrupted`, later steps `not-run`). Adds a new `WAIT_TIMEOUT` error and exit code `11` for timed-out wait steps inside a batch ([#126](https://github.com/coder/agent-tty/pull/126), closes [#123](https://github.com/coder/agent-tty/issues/123)).
- Optional `screenHash` on `snapshot` and render-`wait` results (also on matched `batch` wait steps): a lowercase 64-char SHA-256 of the canonical visible-screen text (`visibleLines[].text` joined by `\n`, no scrollback, cursor, or styles). Gives automation a stable token to tell whether the rendered screen actually changed between two observations without diffing full text, and unlike the Event Log sequence it does not advance on cursor moves or no-op repaints. Present on every result that observed a snapshot (live matches, captures, and the offline `matched:false` fallback); absent only when no screen was observed (live timeout, consecutive-failure giveup, replay-error throw). Standalone `wait` adds an `--after-seq` flag, and `type` / `paste` results now return their Event Log `seq` so callers can anchor a following wait themselves ([#127](https://github.com/coder/agent-tty/pull/127), closes [#125](https://github.com/coder/agent-tty/issues/125)).
- `agent-tty d` is now a short alias for `agent-tty dashboard`. It is an explicit alias (not prefix matching), so it resolves unambiguously to the dashboard and never collides with the other `d`-prefixed commands (`destroy`, `doctor`) ([#129](https://github.com/coder/agent-tty/pull/129)).
- **Home Registry + dashboard Home picker**: agent-tty now remembers every **Home** (state root) that has hosted a Session in a per-machine, advisory index at `${XDG_STATE_HOME:-~/.local/state}/agent-tty/homes.json`, auto-registered on `create` and independent of `AGENT_TTY_HOME`. New `agent-tty home list [--all] [--json]` lists registered Homes — Active Homes by default, `--all` adds terminal-only ones — each with live active/total Session counts and a last-seen timestamp, newest first; `agent-tty home forget <path>` deregisters a Home without touching disk. The read-only `dashboard` gains an additive Home picker (press `H`, `Enter` to switch): browsing Homes performs a read-only scan that never reconciles or mutates a Session, while entering a Home reconciles exactly as the single-Home dashboard does today. Both surfaces prune dead or empty Homes on read so a deleted `mktemp -d` Home never lingers in a listing (ADR 0008, [#131](https://github.com/coder/agent-tty/pull/131), closes [#130](https://github.com/coder/agent-tty/issues/130)).

### Changed

- Both renderer backends (`libghostty-vt` and `ghostty-web`) now produce one canonical visible-screen form (exactly `rows` lines, full grapheme clusters, interior blank cells as spaces, ASCII-only trailing trim) shared by the new Screen Hash, host Screen Stability comparison, and the text Render Wait matcher. This narrows a long-standing divergence so the three can never disagree about "the screen", and intentionally changes the default `ghostty-web` stability/text-wait comparand on screens with grapheme clusters, interior gaps, or non-ASCII trailing characters ([#127](https://github.com/coder/agent-tty/pull/127)).
- README front door rewritten: agent-facing one-liner and "like Playwright, but for terminal apps" framing up top, a new **What you'd use it for** section, a **Watch sessions live** section covering the read-only `dashboard`, and explicit PNG + WebM artifact positioning vs text/asciicast tools. The command surface is folded into prose and moved after the demos; `ROADMAP.md` is retired and every cross-reference removed ([#122](https://github.com/coder/agent-tty/pull/122)). The Codex/Claude agent demo videos now sit right after **What you'd use it for**, before Quickstart, instead of being buried near the bottom ([#128](https://github.com/coder/agent-tty/pull/128)).
- **`gc` is now cross-Home by default** (backward-incompatible): plain `agent-tty gc` sweeps every registered Home and deregisters the ones it empties or finds deleted, rather than collecting only the default Home. The result envelope changes shape accordingly — a top-level `homes[]` of per-Home outcomes (`removedSessions`, `skippedSessions`, `totalBytesFreed`, `existed`, `deregistered`) plus aggregate `removedSessionCount`/`totalBytesFreed`/`deregisteredHomes` — replacing the former flat `removedSessions`/`skippedSessions`/`totalBytesFreed`. Pass `--home <path>` (or set `AGENT_TTY_HOME`) to scope collection to a single Home as before. gc never deletes a Home directory. Automation that relied on `gc` meaning the default Home, or on the old result shape, must pass `--home` and read `homes[]` (ADR 0008, [#131](https://github.com/coder/agent-tty/pull/131), closes [#130](https://github.com/coder/agent-tty/issues/130)).

## [v0.3.0] - 2026-06-03

### Added

- `agent-tty dashboard`: a read-only, interactive Session Dashboard that lists your sessions and shows a live view of the selected one — watch what your agents are doing in their shells, e.g. in a tmux split. The Live View is produced by Event Log Follow (file-tail of `events.jsonl` → `libghostty-vt` `replayTo`/`snapshot`), so it reads the append-only Event Log as the source of truth and never queries the live host (ADR 0006). Master-detail UI with Tab-toggled focus (list select vs. Live View pan), 1:1 clip-top-left/letterbox plus a lossy block-glyph overview (`z`), an active/all scope toggle (`a`), and pin-on-exit (the watched session stays and freezes on its final screen with an exit badge). Requires the optional `libghostty-vt` renderer with no browser fallback, so `doctor` now reports a `dashboard` readiness capability. Interactive-only (no `--json`; fails fast on a non-interactive terminal); machine-readable session listing remains via `list --json` ([#113](https://github.com/coder/agent-tty/pull/113), closes [#109](https://github.com/coder/agent-tty/issues/109)).
- `inspect --json` now reports `host.cliVersion`, `host.rpcSocketPath`, `rendererRuntime.profile`, `rendererRuntime.booted`, `rendererRuntime.bootInFlight` (live mode), and `eventLogBytes` (both live and offline replay). All fields are optional schema additions; existing consumers are unaffected ([#104](https://github.com/coder/agent-tty/pull/104)).
- Canonical proof-bundle lock-down: a new `CanonicalBundleManifestSchema` requires `sha256` and `bytes` on every artifact, `npm run validate-bundle:canonical` (also wired through `mise run validate-bundles`) runs eight drift-detection rules plus catalog parity across the four canonical bundles, and the `linux-static` CI job now fails on bundle drift ([#104](https://github.com/coder/agent-tty/pull/104)).
- Hero Demo bundle (`dogfood/agent-uses-agent-tty/`) replaced with an external Outer Camera flow: VHS records real Codex (`gpt-5.5`) and Claude (`claude-opus-4-7`) TUIs while `agent-tty` produces the inner Neovim proof artifacts. A new `mise run demo:agent-uses-agent-tty` task regenerates and promotes the demo with pinned `vhs`/`ttyd`/`ffmpeg` ([#105](https://github.com/coder/agent-tty/pull/105)).
- Hero Demo video playback workflow: `mise run demo:agent-uses-agent-tty:upload-assets` prepares H.264 MP4 upload assets (with the curated thumbnail held as the opening frames so GitHub's natural first-frame poster shows the end-state), and `mise run demo:agent-uses-agent-tty:apply-video-urls` rewrites the inline `<video>` srcs in the root and bundle READMEs and refreshes the manifest. Full guidance lives in `dogfood/agent-uses-agent-tty/VIDEO_PLAYBACK.md` ([#106](https://github.com/coder/agent-tty/pull/106)).
- README rebuild with one-line value prop, badge row, hero GIF, a "Why not tmux/expect/asciinema/Playwright?" comparison table, a two-backend "How it works" section (`libghostty-vt` + `ghostty-web`), and an origin story. Adds `assets/hero.{gif,tape}` and a Playwright-rendered 1200×630 social card under `assets/social-preview.*` ([#108](https://github.com/coder/agent-tty/pull/108)).
- Session Dashboard planning docs: ADR 0006 (Event Log Follow + `libghostty-vt` backend), `docs/prd/session-dashboard/PRD.md`, and new glossary terms in `CONTEXT.md` (Session Dashboard, Live View, Event Log Follow) ([#110](https://github.com/coder/agent-tty/pull/110)).

### Changed

- The README hero GIF (`assets/hero.tape`) and the `dogfood/agent-uses-agent-tty/` Codex/Claude recordings now record inside a tmux two-pane split: the agent (or, in the hero, plain `agent-tty` CLI calls) drives a session on the left while `agent-tty dashboard` live-mirrors it on the right — showing the dashboard reacting as sessions are created and modified. Both panes share one `AGENT_TTY_HOME` so the dashboard auto-follows the newest session; the status bar is disabled so VHS's whole-screen `Wait+Screen` scrape stays unambiguous, and each run uses an isolated, reaped tmux server socket. The hero hides the tmux split plumbing and instead launches the dashboard on camera — typing `agent-tty dashboard` into the right pane and hopping back with the tmux prefix — and its panes/session run `bash --norc` with a minimal prompt so the live mirror stays free of personal shell-prompt clutter. It runs against this checkout's freshly-built CLI, since `agent-tty dashboard` is unreleased. A new `mise run demo:hero` task (which `depends` on `build`) regenerates the hero GIF, joining `mise run demo:agent-uses-agent-tty` for the agent recordings. `tmux` (`>= 3.1`, pinned to `3.6` in `mise`) is now a recorder prerequisite alongside `vhs`/`ttyd`/`ffmpeg`. The agent recordings now run concurrently via a bounded worker pool (`--concurrency`, default `2`) — each run is mostly an idle review-window sleep, so overlapping the two agents roughly halves wall-clock; raising the cap also overlaps an agent's own retry attempts at the cost of more CPU and shared-account load, while same-agent attempts stay serialized so two sessions of one account never record at once ([#116](https://github.com/coder/agent-tty/pull/116)).
- Spawned shells now default `PROMPT_EOL_MARK=` (empty) in the session environment, suppressing the inverse-video `%` end-of-partial-line marker that `zsh` prints when output lacks a trailing newline. agent-tty strips a hidden completion-marker postamble after each `run`, which desynced the rendered cursor and left that `%` in snapshots, screenshots, and recordings; the default keeps captures clean. The marker is zsh-only and inert in other shells. Opt back in per session with `agent-tty create --env PROMPT_EOL_MARK='%B%S%#%s%b' -- <shell>` to restore zsh's styled default (a lone `'%'` expands to nothing), or pass any explicit `--env PROMPT_EOL_MARK=...` value. The default is applied at PTY spawn time and is not written to the manifest, so `inspect`, `list`, and `create --json` env maps are unchanged ([#114](https://github.com/coder/agent-tty/pull/114)).
- `inspect` collects renderer state and the session snapshot in a single synchronous tick before awaiting, so concurrent RPC handlers cannot interleave a mutated renderer state with a stale session snapshot ([#104](https://github.com/coder/agent-tty/pull/104)).

### Fixed

- Wide characters (CJK/emoji) no longer misalign per-cell snapshot rendering. The `libghostty-vt` backend's `mapNativeCells` packed one array entry per native cell _record_ and discarded the native `col`/`width`, so a width-2 glyph became a single entry with no spacer for its trailing column — shifting every cell after it one column to the left and offsetting the cursor-cell highlight in the Session Dashboard (which pins `libghostty-vt`). Cells are now column-indexed: each row places records at their true column and emits an empty spacer for a wide glyph's trailing column, matching the `ghostty-web` backend so `snapshot --include-cells` and the dashboard Live View stay aligned past wide glyphs. `visibleLines` text was already correct ([#118](https://github.com/coder/agent-tty/pull/118), closes [#112](https://github.com/coder/agent-tty/issues/112)).
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
