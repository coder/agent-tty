# Default semantic renderer proof bundle

This bundle proves the split renderer default: semantic actions (`wait`, `snapshot`, and screen-hash producing paths) now default to `libghostty-vt` when the optional native package is available, while visual artifacts still default to `ghostty-web`.

## What this proves

- `expected-renderer.json` records the automatic semantic renderer detected in this workspace. In this capture it is `libghostty-vt`.
- `default-wait.json` was captured without `--renderer`, exercising the automatic semantic render-wait path.
- `default-snapshot.json` was captured without `--renderer`; `default-snapshot-artifact.json` records the snapshot artifact metadata with `rendererBackend: "libghostty-vt"`.
- `default-screenshot.json` was captured without `--renderer` and reports `result.rendererBackend: "ghostty-web"`; the PNG is copied to `screenshots/default-screenshot.png`.
- `default-webm.json` was captured without `--renderer` and reports `result.metadata.rendererBackend: "ghostty-web"`; the WebM is copied to `videos/default-webm.webm`.
- `explicit-ghostty-web-snapshot.json` proves the legacy override path; `explicit-ghostty-web-snapshot-artifact.json` records `rendererBackend: "ghostty-web"`.
- `explicit-libghostty-vt-screenshot.json` proves explicit native screenshot requests still produce honest `ghostty-web` PNG metadata via fallback.
- `explicit-libghostty-vt-webm.json` proves explicit native WebM requests are accepted while the actual video producer remains `ghostty-web`.
- `default-cast.json` and `recordings/default.cast` keep a terminal recording of the session.

## Bundle contents

- `commands.sh` — self-contained replay script using an isolated `AGENT_TTY_HOME` from `mktemp -d` and the repo-local CLI via `npx tsx src/cli/main.ts`.
- `environment.txt`, `version.json`, `doctor.json`, `expected-renderer.json` — environment and capability evidence.
- `default-*.json` — default renderer behavior envelopes.
- `explicit-*.json` — explicit override behavior envelopes.
- `*-artifact.json` and `artifact-manifest.json` — artifact metadata used to verify semantic snapshot producers.
- `screenshots/*.png` — visual proof artifacts.
- `videos/*.webm` — video proof artifacts.
- `recordings/default.cast` — asciicast recording.
- `artifact-file-info.txt` and `artifact-sha256.txt` — file type and checksum evidence for copied artifacts.

## How to reproduce

From the repository root:

```bash
bash dogfood/20260616-default-semantic-renderer/commands.sh
```

The script requires `git`, `jq`, `node`, `npm`, `npx`, and the installed project dependencies. It never writes to `~/.agent-tty`; every CLI command uses the temporary `AGENT_TTY_HOME` created at startup.

## Reviewer checks

```bash
jq -r '.expectedSemanticRenderer' dogfood/20260616-default-semantic-renderer/expected-renderer.json
jq -r '.metadata.rendererBackend' \
  dogfood/20260616-default-semantic-renderer/default-snapshot-artifact.json \
  dogfood/20260616-default-semantic-renderer/explicit-ghostty-web-snapshot-artifact.json
jq -r '.result.rendererBackend' \
  dogfood/20260616-default-semantic-renderer/default-screenshot.json \
  dogfood/20260616-default-semantic-renderer/explicit-libghostty-vt-screenshot.json
jq -r '.result.metadata.rendererBackend' \
  dogfood/20260616-default-semantic-renderer/default-webm.json \
  dogfood/20260616-default-semantic-renderer/explicit-libghostty-vt-webm.json
file dogfood/20260616-default-semantic-renderer/screenshots/*.png
file dogfood/20260616-default-semantic-renderer/videos/*.webm
file dogfood/20260616-default-semantic-renderer/recordings/*.cast
```

Expected output in this workspace: semantic snapshot metadata starts with `libghostty-vt`, the explicit legacy snapshot reports `ghostty-web`, and all screenshot/WebM producer fields report `ghostty-web`.
