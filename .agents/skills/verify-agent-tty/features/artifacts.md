# Artifacts

A user captures what a session showed: a semantic snapshot of the screen, a rendered PNG screenshot, a recording as an asciicast `.cast` or a WebM video, and a diff of the visible screens of two sessions. Each artifact is listed in the session's artifact manifest and can be rebuilt from the event log.

## Sub-features

- `art-snapshot-text` returns the visible screen as text with a `screenHash`.
- `art-snapshot-structured` returns the screen as structured rows, optionally with cells and scrollback.
- `art-screenshot` renders a PNG with a render profile.
- `art-record-cast` exports an asciicast v2 recording.
- `art-record-webm` exports a WebM video of the replayed screen.
- `art-record-diff` compares the visible screens of two sessions.
- `art-manifest` lists every artifact with its kind in `artifacts/manifest.json`.
- `art-offline` exports artifacts of a session whose program has exited.

## How to get to it (user POV)

- `agent-tty snapshot <id>`, with `--format text|structured`, `--include-scrollback`, `--include-cells`.
- `agent-tty screenshot <id>`, with `--profile reference-dark|reference-light`, `--show-cursor`, `--hide-cursor`.
- `agent-tty record export <id> --format asciicast|webm`, with `--out <path>`, `--profile`, `--timing recorded|accelerated|max-speed`.
- `agent-tty record diff <id-a> <id-b>`, with `--at-seq-a`, `--at-seq-b`.

## Driving it with att

Preconditions:

- `mkdir -p "$EVIDENCE/art"` has run. The recipe saves its proof there.
- The baseline preconditions in the README hold.
- `H=$(att create --json -- node --import tsx test/fixtures/apps/hello-prompt/main.ts | jq -r .result.sessionId)`, its `READY>` wait matches, then `att type "$H" artifact-proof --append-newline --json` and `att wait "$H" --text 'ECHO: artifact-proof' --timeout 10000 --json` matches.
- A shell session: `B=$(att create --json --env 'PS1=$ ' -- /bin/bash --noprofile --norc | jq -r .result.sessionId)`.

- **Text snapshot.** Run `att snapshot "$H" --format text --json | tee "$EVIDENCE/art/snapshot.json"`. `.result.text` contains `ECHO: artifact-proof`, and `.result` has `capturedAtSeq`, `cursorRow`, `cursorCol` and a 64-hex `screenHash`.
- **Structured snapshot.** Run `att snapshot "$H" --format structured --json | tee "$EVIDENCE/art/structured.json"`. `.result.format` is `structured`, `.result.visibleLines` has 24 entries of `{row, text}`, including `{"row":1,"text":"ECHO: artifact-proof"}`, and `.result` has no `cells` and no `scrollbackLines` key.
- **Cells and scrollback.** Run `att run "$B" "seq 1 30; printf '\033[1;31m%s\033[0m\n' bold-red" --json`, then `att snapshot "$B" --format structured --include-cells --include-scrollback --json | tee "$EVIDENCE/art/structured-full.json"`. `.result.scrollbackLines` holds the 9 rows that scrolled off the top: the command line, then `1` to `8`. `.result.visibleLines[0].text` is `9`. In `.result.cells`, the `{lineNumber, cells}` entry of the `bold-red` row has one cell per character, and each cell has `bold: true` and an `fg` color.
- **Screenshot.** Run `att screenshot "$H" --json | tee "$EVIDENCE/art/screenshot.json"`. `.result.artifactPath` ends in `screenshot-<seq>-reference-dark.png`, `rendererBackend` is `ghostty-web`, `pixelWidth` and `pixelHeight` are set, and the file's SHA-256 equals `.result.sha256`. Compute it with Node, which works on Linux and macOS: `node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$(jq -r .result.artifactPath "$EVIDENCE/art/screenshot.json")"`. Copy the PNG to `$EVIDENCE/art/` and look at it: it shows `READY>` and `ECHO: artifact-proof` on a dark background.
- **Light profile.** Run `att screenshot "$H" --profile reference-light --json`. The file name ends in `-reference-light.png`, and the image has a light background.
- **Asciicast.** Run `att record export "$H" --format asciicast --json`. `.result.artifactPath` ends in `.cast`, and the file's first line is a JSON header with `"width":80` and `"height":24`.
- **WebM.** Run `att record export "$H" --format webm --json`. `.result.artifactPath` ends in `.webm`, and `.result.bytes` is larger than 0. It can take tens of seconds on a long session.
- **Manifest.** Run `jq -c '[.artifacts[].kind]' "$AGENT_TTY_HOME/sessions/$H/artifacts/manifest.json"`. It lists one entry per artifact of `H` above: `snapshot` (twice: the text and the structured snapshot), `screenshot` (twice), `recording` (the `.cast`) and `video` (the `.webm`). The snapshot of `B` is in the manifest of `B`.
- **Diff.** Create a second `hello-prompt` session `H2` and wait for its prompt, then run `att record diff "$H" "$H2" --json`. `.result.identical` is `false`, and `.result.diff` starts with `delete` entries for `READY> artifact-proof` and `ECHO: artifact-proof` (rows of session A), then an `equal` entry for `READY>`.
- **Offline export.** Run `att send-keys "$H" Ctrl+C --json` and `att wait "$H" --exit --timeout 10000 --json`, then `att screenshot "$H" --json`. The export still succeeds (`ok: true`, a new `screenshot-<seq>-reference-dark.png`), rendered from the event log of the exited session.

## Gotchas

- `screenshot` and WebM export need Playwright Chromium. If `doctor.sh` reports `browser_launch` failing, run `mise run bootstrap` (it installs Chromium) before you report a renderer bug.
- The default renderer differs by command: semantic commands prefer `libghostty-vt`, visual artifacts use `ghostty-web`. Pass `--renderer <name>` to compare.
- With `--include-cells`, the default `libghostty-vt` renderer returns entries only for rows that hold text, and `--renderer ghostty-web` returns one for every row. Assert on rows that you know hold text.
- A screenshot shows the reference renderer, not your terminal emulator. Do not claim native-terminal parity from it.
- WebM export is slow. Export it once per proof, at the end.
