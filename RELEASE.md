# agent-terminal 0.1.0 release contract

`agent-terminal` `0.1.0` is the first release that explicitly targets isolated, reviewable terminal automation for real TUI workflows.
The contract below is the bar for what maintainers should feel comfortable supporting at release time.
If a workflow depends on behavior outside this document, treat it as future-scope or best-effort rather than a guaranteed `0.1.0` capability.
For intentionally deferred work, see [`ROADMAP.md`](./ROADMAP.md). For reviewer-facing proof bundles, start with [`dogfood/CATALOG.md`](./dogfood/CATALOG.md).

## What 0.1.0 delivers

- Reliable isolated session lifecycle management: `create`, `inspect`, `destroy`, and `gc` all work against isolated agent-terminal homes.
- Renderer-backed screenshots, semantic snapshots, and WebM export for reviewer-visible proof artifacts.
- The `run` command for robust in-session command execution without having to simulate long shell setup scripts as manual keystrokes.
- `doctor --json` with isolation-aware diagnostics for home resolution, renderer prerequisites, and screenshot viability.
- An append-only event log that remains the canonical replay/export source of truth.
- Schema-locked JSON envelopes across the public CLI surface.

## What 0.1.0 explicitly does not deliver

- Native renderer backends such as Ghostty native or kitty.
- Mouse input support.
- Remote or networked sessions.
- An MCP wrapper.
- Full semantic TUI automation.
- Cross-terminal pixel parity.
- Output capture or exit-code detection from `run`.

## Known limitations

- The renderer is the `ghostty-web` reference backend, not a native-terminal parity guarantee.
- `run` completion detection relies on shell-visible echo of an injected boundary marker.
- Screenshots and WebM export require Playwright/Chromium to be installed and discoverable.
- The reviewed LazyVim workflow currently assumes Neovim `>= 0.11.2` plus its usual prerequisites; older Neovim builds are out of contract for that scenario.

## Validation

- Current release bar: 602 tests across 56 test files.
- Reviewer-facing proof bundles are cataloged in [`dogfood/CATALOG.md`](./dogfood/CATALOG.md), including `dogfood/20260326-week9-release-readiness/`, `dogfood/run-command/`, and `dogfood/20260325-week8-contract-locks/`.
- Run `npm run verify` for the full validation bar.
