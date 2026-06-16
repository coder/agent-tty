# agent-tty release contract

This document defines the supported product contract for the current `0.2.x` release line.
The `0.1.x` beta line established the baseline for isolated, reviewable terminal automation for real TUI workflows, and `0.2.0` is the first stable cut on top of that baseline; later `0.2.x` releases may add compatible fixes and features without widening this core support contract.
If a workflow depends on behavior outside this document, treat it as future-scope or best-effort rather than a guaranteed capability.

For per-release changes, see [`CHANGELOG.md`](./CHANGELOG.md). For release mechanics, use [`docs/RELEASE-PROCESS.md`](./docs/RELEASE-PROCESS.md). For reviewer-facing proof bundles, start with [`dogfood/CATALOG.md`](./dogfood/CATALOG.md).

## Supported capabilities

- Reliable isolated session lifecycle management: `create`, `inspect`, `destroy`, and `gc` all work against isolated agent-tty homes.
- Renderer-backed screenshots, semantic snapshots, and WebM export for reviewer-visible proof artifacts; semantic operations prefer `libghostty-vt` when available, while visual artifacts use `ghostty-web`.
- The `run` command for robust in-session command execution without having to simulate long shell setup scripts as manual keystrokes.
- `doctor --json` with isolation-aware diagnostics for home resolution, renderer prerequisites, and screenshot viability.
- An append-only event log that remains the canonical replay/export source of truth.
- Schema-locked JSON envelopes across the public CLI surface.

## Explicitly out of scope

- Additional native renderer backends beyond the shipped `libghostty-vt` semantic renderer, such as kitty or platform terminal automation.
- Mouse input support.
- Remote or networked sessions.
- An MCP wrapper.
- Full semantic TUI automation.
- Cross-terminal pixel parity.
- Output capture or exit-code detection from `run`.

## Known limitations

- Semantic operations may use `libghostty-vt`, but visual screenshots and WebM remain `ghostty-web` reference artifacts, not a native-terminal parity guarantee.
- `run` completion detection relies on shell-visible echo of an injected boundary marker.
- Screenshots and WebM export require Playwright/Chromium to be installed and discoverable.
- The reviewed LazyVim workflow currently assumes Neovim `>= 0.11.2` plus its usual prerequisites; older Neovim builds are out of contract for that scenario.

## Validation

- Reviewer-facing proof bundles are cataloged in [`dogfood/CATALOG.md`](./dogfood/CATALOG.md), including `dogfood/20260326-week9-release-readiness/`, `dogfood/run-command/`, and `dogfood/20260325-week8-contract-locks/`.
- The maintainer release process in [`docs/RELEASE-PROCESS.md`](./docs/RELEASE-PROCESS.md) defines the current validation bar.
