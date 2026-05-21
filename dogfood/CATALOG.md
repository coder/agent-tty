# Dogfood catalog

Use this catalog to find the most useful proof bundles without having to understand the entire historical `dogfood/` tree.
Paths below are relative to the repository root.

## Canonical scenarios

| Scenario         | What it demonstrates                                                                                          | Bundle                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Hello prompt     | Basic lifecycle, wait, screenshot, and recording flow                                                         | `dogfood/20260322-dogfood-hello-prompt/` |
| Run command      | The higher-level `run` workflow for shell setup and command injection                                         | `dogfood/run-command/`                   |
| Color rendering  | ANSI color capture and screenshot review                                                                      | `dogfood/20260322-dogfood-color/`        |
| Alternate screen | Entering and leaving an alt-screen TUI while preserving the main screen                                       | `dogfood/20260322-dogfood-alt-screen/`   |
| Resize           | PTY resizing and stable-screen verification                                                                   | `dogfood/20260322-dogfood-resize/`       |
| Scrollback       | Scrollback-aware snapshots, screenshots, and recording export                                                 | `dogfood/20260322-dogfood-scrollback/`   |
| Unicode          | Unicode rendering plus snapshot/export review                                                                 | `dogfood/20260322-dogfood-unicode/`      |
| LazyVim          | A real TUI scenario that exercises editor startup and reviewer-visible artifacts                              | `dogfood/20260322-lazyvim-scenario/`     |
| Agent uses TTY   | VHS-recorded Codex and Claude TUIs exploring `agent-tty`, driving Neovim, and exporting inner proof artifacts | `dogfood/agent-uses-agent-tty/`          |
| Public skill     | The shipped `skills/agent-terminal/` workflow and documentation surface                                       | `dogfood/20260327-public-skill/`         |
| Install flows    | Pre-public tarball install proof plus the current local git-install caveat evidence                           | `dogfood/install-flows/`                 |
| Config parity    | Configuration/profile behavior checks that remain useful as a standing scenario                               | `dogfood/week5-config-parity/`           |

## Validation and release gates

| Bundle                                         | Why it matters                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `dogfood/20260326-week9-release-readiness/`    | Current release-signoff bundle for the `0.1.0` bar.                                                                        |
| `dogfood/20260429-release-it-prep/`            | Disposable-origin proof for `release:prep` / `release:finalize` guardrails, screenshot, transcript, and WebM recording.    |
| `dogfood/20260410-release-tarball/`            | Local proof of the shared release tarball packer, checksum, and install flow used by the GitHub release workflow.          |
| `dogfood/20260325-week8-contract-locks/`       | Contract-lock and reporting review evidence.                                                                               |
| `dogfood/20260325-week8-bundle-validation/`    | Validation of proof-bundle conventions.                                                                                    |
| `dogfood/20260325-week8-capability-inventory/` | Runtime capability inventory/reporting evidence.                                                                           |
| `dogfood/20260325-week8-inspect-runtime/`      | `inspect --json` runtime reporting review.                                                                                 |
| `dogfood/oxlint-oxfmt-migration/`              | Oxc lint/format migration proof with migrated checks, screenshot, asciicast, and WebM recording.                           |
| `dogfood/token-usage-phase5-proof/`            | Phase 5 eval DX token-usage proof bundle (commit `91a571de`) with screenshot, WebM recording, snapshot, and replay script. |
| `dogfood/20260323-week5-platform-closure/`     | Platform/documentation closeout evidence from the earlier hardening phase.                                                 |

| `dogfood/20260330-docs-navigation/` | Repository docs walkthrough with screenshots and a WebM recording of the new navigation path. |

Follow-up: `dogfood/token-usage-phase5-proof/` is the only dedicated eval DX phase bundle currently cataloged. Dedicated proof bundles for the authoring façade, reporter lifecycle, and workspace-preset phases (Phases 1-4) are not currently present under `dogfood/`; reviewers who need fresh artifacts for those phases should capture a local proof bundle.

## Recovery and hardening

| Bundle                                      | Focus                                                      |
| ------------------------------------------- | ---------------------------------------------------------- |
| `dogfood/20260322-dogfood-crash/`           | Crash handling, retained artifacts, and post-crash review. |
| `dogfood/20260322-week4-failure-recovery/`  | Earlier failure-recovery flow review.                      |
| `dogfood/20260323-week5-recovery-host/`     | Host-death and reconciliation behavior.                    |
| `dogfood/20260323-week5-recovery-renderer/` | Renderer failure and recovery behavior.                    |
| `dogfood/20260323-week5-recovery-replay/`   | Replay/offline recovery behavior.                          |
| `dogfood/20260321-week3-crash-retention/`   | Historical crash-retention proof for the week-3 milestone. |
| `dogfood/20260321-post-hardening-smoke/`    | Smoke validation after hardening work.                     |
| `dogfood/20260323-bugfix-resize/`           | Resize regression repro/fix evidence.                      |
| `dogfood/20260323-bugfix-scrollback/`       | Scrollback regression repro/fix evidence.                  |

## Historical bundles

These bundles remain useful context, but they are mostly project-history artifacts rather than the first places a new reviewer should start:

- Early lifecycle and renderer milestone bundles: `dogfood/20260319-*`, `dogfood/20260320-*`, `dogfood/20260321-*`.
- Week-4 historical review bundles: `dogfood/20260322-dogfood-week4-features/`, `dogfood/20260322-global-cli-context/`, `dogfood/20260322-week4-cli-parity/`, `dogfood/20260322-week4-scrollback-review/`, `dogfood/20260322-week4-unicode-review/`.
- Week-5 historical workstreams: `dogfood/20260323-week5-*` that are not listed above as canonical or recovery references.
- Week-6 and Week-7 phased rollout bundles: `dogfood/20260325-week6-*` and `dogfood/20260325-week7-*`.
- Font fallback investigations: `dogfood/20260326-lazyvim-nerd-font-check/`, `dogfood/20260326-lazyvim-nerd-font-check-2/`, and `dogfood/20260326-nerd-font-fallback/`.

## Catalog maintenance rules

- Add a bundle to this file when reviewers should be able to find it quickly without browsing the whole directory.
- Prefer stable, descriptive scenario names over weekly status labels when promoting evergreen workflows.
- Keep one-off or superseded investigations out of the canonical sections unless they remain the best proof for a still-important behavior.
