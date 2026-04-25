# Phase 6 libghostty-vt renderer proof bundle

This bundle captures a focused Phase 6 dogfood run for commit `efee65e` (`feat(renderer): add selectable libghostty-vt backend`). It demonstrates the new global `--renderer libghostty-vt` flag end-to-end against the `hello-prompt` fixture, with a `--renderer ghostty-web` baseline captured from the same terminal interaction.

## What this proves

- The native addon is installed and importable: `native-info.json` is the raw output from `@coder/libghostty-vt-node`'s `getNativeInfo()` and reports package `0.1.0-beta.0` on linux/x64.
- `ghostty-web` remains a working baseline renderer: `ghostty-web-wait.json`, `ghostty-web-snapshot.json`, `ghostty-web-screenshot.json`, and `screenshots/ghostty-web.png` were produced with `--renderer ghostty-web`.
- `libghostty-vt` is selectable for semantic renderer operations: `libghostty-vt-wait.json` and `libghostty-vt-snapshot.json` were produced with `--renderer libghostty-vt` after driving the fixture with `type` + `send-keys`.
- PNG screenshot fallback is honest about its producer: `libghostty-vt-screenshot.json` was requested with `--renderer libghostty-vt`, and its `result.rendererBackend` is `ghostty-web`. The copied PNG is `screenshots/libghostty-vt-fallback.png`.
- WebM export fallback is also honest about its producer: `libghostty-vt-record-webm.json` was requested with `--renderer libghostty-vt`, and its `result.metadata.rendererBackend` is `ghostty-web`. The copied video is `videos/libghostty-vt-fallback.webm`.
- The terminal recording remains available as asciicast: `libghostty-vt-record-cast.json` exports `recordings/terminal-session.cast`.
- `inspect.json` was captured near the end of the native session after clean fixture exit and export. It shows a clean-exit session with healthy snapshot, screenshot, recording, and video artifacts. Because the process had already exited, `inspect` uses offline replay and reports the replay fallback runtime; the semantic renderer proof is in the `--renderer libghostty-vt` wait/snapshot commands and envelopes.

The two PNGs are byte-identical in this capture. `commands.sh` enforces that with `cmp -s` after copying both screenshots.

## Bundle contents

- `commands.sh` — self-contained replay script. It creates an isolated `AGENT_TTY_HOME` with `mktemp -d -t agent-tty-dogfood.XXXXXX`, runs the repo-local CLI via `npx tsx src/cli/main.ts`, captures all envelopes/artifacts, and cleans up the temporary home.
- `environment.txt` — Node/npm versions, git HEAD, OS details, the requested root `--version` probe, supported `version --json` output, and native-addon metadata.
- `native-info.json` — raw native addon metadata from `getNativeInfo()`.
- `ghostty-web-*.json` — baseline wait, snapshot, and screenshot envelopes.
- `libghostty-vt-*.json` — native-run wait, snapshot, screenshot, asciicast export, and WebM export envelopes.
- `inspect.json` — final native session inspection envelope.
- `screenshots/ghostty-web.png` — baseline ghostty-web PNG.
- `screenshots/libghostty-vt-fallback.png` — PNG requested under `--renderer libghostty-vt` and produced by the ghostty-web fallback path.
- `recordings/terminal-session.cast` — asciicast export for the native run. The current CLI schema names the format `asciicast`; the artifact uses the conventional `.cast` extension.
- `videos/libghostty-vt-fallback.webm` — WebM export requested under `--renderer libghostty-vt` and produced by the ghostty-web fallback path.

## How to reproduce

From the repository root:

```bash
bash dogfood/20260424-libghostty-vt-renderer/commands.sh
```

The script requires `jq`, `node`, `npm`, `npx`, and the already-installed project dependencies. It does not write to `~/.agent-tty`; every CLI invocation uses the temporary `AGENT_TTY_HOME` created at script startup.

## Reviewer checks

```bash
find dogfood/20260424-libghostty-vt-renderer -type f | sort
jq '.ok' dogfood/20260424-libghostty-vt-renderer/*.json
jq -r '.result.rendererBackend' dogfood/20260424-libghostty-vt-renderer/libghostty-vt-screenshot.json
jq -r '.result.metadata.rendererBackend' dogfood/20260424-libghostty-vt-renderer/libghostty-vt-record-webm.json
file dogfood/20260424-libghostty-vt-renderer/screenshots/*.png
file dogfood/20260424-libghostty-vt-renderer/videos/*.webm
file dogfood/20260424-libghostty-vt-renderer/recordings/*.cast
cmp -s \
  dogfood/20260424-libghostty-vt-renderer/screenshots/ghostty-web.png \
  dogfood/20260424-libghostty-vt-renderer/screenshots/libghostty-vt-fallback.png
```

`jq '.ok'` prints `true` for every CLI envelope. It prints `null` once for `native-info.json` because that file is intentionally the raw native-addon info object, not a CLI envelope.
