#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUNDLE_DIR="$SCRIPT_DIR"
SCREENSHOTS_DIR="$BUNDLE_DIR/screenshots"
RECORDINGS_DIR="$BUNDLE_DIR/recordings"
COMMAND_LOG="$BUNDLE_DIR/command-log.tsv"
CLI=(npx tsx src/cli/main.ts)
FIXTURE=(npx tsx test/fixtures/apps/hello-prompt/main.ts)
SESSION_HOME=""
SESSION_ID=""
CLI_NODE_VERSION=""
NPM_VERSION=""
GIT_COMMIT=""
SKILLS_LIST_PATH=""
SKILLS_GET_AGENT_TTY_PATH=""
SKILLS_GET_DOGFOOD_TUI_PATH=""
SKILLS_PATH_AGENT_TTY_DIR=""
SKILLS_PATH_DOGFOOD_TUI_DIR=""
SCREENSHOT_SOURCE_PATH=""
SCREENSHOT_DEST_PATH="$SCREENSHOTS_DIR/hello-prompt-echo.png"
CAST_PATH="$RECORDINGS_DIR/hello-prompt.cast"
WEBM_PATH="$RECORDINGS_DIR/hello-prompt.webm"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

assert_file() {
  local path="$1"
  [[ -f "$path" ]] || {
    printf 'expected file to exist: %s\n' "$path" >&2
    exit 1
  }
}

assert_dir() {
  local path="$1"
  [[ -d "$path" ]] || {
    printf 'expected directory to exist: %s\n' "$path" >&2
    exit 1
  }
}

command_string() {
  local rendered
  printf -v rendered '%q ' "$@"
  printf '%s' "${rendered% }"
}

log_step() {
  local label="$1"
  local exit_code="$2"
  local command="$3"
  printf '%s\t%s\t%s\n' "$label" "$exit_code" "$command" >> "$COMMAND_LOG"
}

run_json() {
  local label="$1"
  shift
  local output_path="$BUNDLE_DIR/$label"
  local -a cmd=("$@")
  local rendered_command
  rendered_command="$(command_string "${cmd[@]}") > "$output_path""
  local exit_code=0
  if ! "${cmd[@]}" > "$output_path"; then
    exit_code=$?
  fi
  log_step "$label" "$exit_code" "$rendered_command"
  (( exit_code == 0 )) || return "$exit_code"
}

run_shell_capture() {
  local label="$1"
  local shell_command="$2"
  local output_path="$BUNDLE_DIR/$label"
  local exit_code=0
  if ! bash -lc "$shell_command" > "$output_path"; then
    exit_code=$?
  fi
  log_step "$label" "$exit_code" "$shell_command > $output_path"
  (( exit_code == 0 )) || return "$exit_code"
}

cleanup() {
  local exit_code=$?
  if [[ -n "$SESSION_ID" && -n "$SESSION_HOME" && -d "$SESSION_HOME" ]]; then
    if [[ ! -f "$BUNDLE_DIR/tui-destroy.json" ]]; then
      set +e
      "${CLI[@]}" --home "$SESSION_HOME" destroy "$SESSION_ID" --json > "$BUNDLE_DIR/tui-destroy.json"
      local destroy_exit_code=$?
      set -e
      log_step \
        'tui-destroy.json' \
        "$destroy_exit_code" \
        "$(command_string "${CLI[@]}" --home "$SESSION_HOME" destroy "$SESSION_ID" --json) > $BUNDLE_DIR/tui-destroy.json"
    fi
    rm -rf "$SESSION_HOME"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

require_command npx
require_command npm
require_command jq
require_command python3

mkdir -p "$SCREENSHOTS_DIR" "$RECORDINGS_DIR"
find "$BUNDLE_DIR" -maxdepth 1 -type f ! -name 'commands.sh' -delete
find "$SCREENSHOTS_DIR" -maxdepth 1 -type f -delete
find "$RECORDINGS_DIR" -maxdepth 1 -type f -delete
: > "$COMMAND_LOG"

cd "$REPO_ROOT"

CLI_NODE_VERSION="$(npx tsx --eval 'console.log(process.version)')"
NPM_VERSION="$(npm -v)"
GIT_COMMIT="$(git rev-parse --short HEAD)"
SESSION_HOME="$(mktemp -d)"

printf '%s\n' "$SESSION_HOME" > "$BUNDLE_DIR/agent-tty-home.txt"
log_step 'agent-tty-home.txt' 0 "mktemp -d > $BUNDLE_DIR/agent-tty-home.txt"

run_json 'skills-list.json' "${CLI[@]}" skills list --json
run_json 'skills-get-agent-tty.json' "${CLI[@]}" skills get agent-tty --json
run_json 'skills-get-dogfood-tui.json' "${CLI[@]}" skills get dogfood-tui --json
run_json 'skills-path-agent-tty.json' "${CLI[@]}" skills path agent-tty --json
run_json 'skills-path-dogfood-tui.json' "${CLI[@]}" skills path dogfood-tui --json
run_shell_capture 'npm-pack-skill-files.txt' "npm pack --json --dry-run 2>/dev/null | jq -r '.[0].files[] | .path' | grep -E '^(skills|skill-data)/'"

SKILLS_LIST_PATH="$(jq -r '.result.skills[] | select(.name == "agent-tty") | .path' "$BUNDLE_DIR/skills-list.json")"
SKILLS_GET_AGENT_TTY_PATH="$(jq -r '.result.path' "$BUNDLE_DIR/skills-get-agent-tty.json")"
SKILLS_GET_DOGFOOD_TUI_PATH="$(jq -r '.result.path' "$BUNDLE_DIR/skills-get-dogfood-tui.json")"
SKILLS_PATH_AGENT_TTY_DIR="$(jq -r '.result.path' "$BUNDLE_DIR/skills-path-agent-tty.json")"
SKILLS_PATH_DOGFOOD_TUI_DIR="$(jq -r '.result.path' "$BUNDLE_DIR/skills-path-dogfood-tui.json")"

run_json 'tui-doctor.json' "${CLI[@]}" --home "$SESSION_HOME" doctor --json
run_json 'tui-create.json' "${CLI[@]}" --home "$SESSION_HOME" create --json -- "${FIXTURE[@]}"
SESSION_ID="$(jq -r '.result.sessionId' "$BUNDLE_DIR/tui-create.json")"
[[ -n "$SESSION_ID" && "$SESSION_ID" != 'null' ]] || {
  printf 'failed to extract session id from tui-create.json\n' >&2
  exit 1
}
printf '%s\n' "$SESSION_ID" > "$BUNDLE_DIR/session-id.txt"
log_step 'session-id.txt' 0 "jq -r '.result.sessionId' $BUNDLE_DIR/tui-create.json > $BUNDLE_DIR/session-id.txt"

run_json 'tui-wait-ready.json' "${CLI[@]}" --home "$SESSION_HOME" wait "$SESSION_ID" --json --text 'READY> '
run_json 'tui-type-agent.json' "${CLI[@]}" --home "$SESSION_HOME" type "$SESSION_ID" --json 'Agent'
run_json 'tui-send-enter.json' "${CLI[@]}" --home "$SESSION_HOME" send-keys "$SESSION_ID" --json Enter
run_json 'tui-wait-echo.json' "${CLI[@]}" --home "$SESSION_HOME" wait "$SESSION_ID" --json --text 'ECHO: Agent'
run_json 'tui-wait-stable.json' "${CLI[@]}" --home "$SESSION_HOME" wait "$SESSION_ID" --json --screen-stable-ms 500
run_json 'tui-snapshot-text.json' "${CLI[@]}" --home "$SESSION_HOME" snapshot "$SESSION_ID" --format text --json
run_json 'tui-screenshot-echo.json' "${CLI[@]}" --home "$SESSION_HOME" screenshot "$SESSION_ID" --json
SCREENSHOT_SOURCE_PATH="$(jq -r '.result.artifactPath' "$BUNDLE_DIR/tui-screenshot-echo.json")"
assert_file "$SCREENSHOT_SOURCE_PATH"
cp "$SCREENSHOT_SOURCE_PATH" "$SCREENSHOT_DEST_PATH"
log_step 'copy-screenshot' 0 "cp $SCREENSHOT_SOURCE_PATH $SCREENSHOT_DEST_PATH"

run_json 'tui-type-exit.json' "${CLI[@]}" --home "$SESSION_HOME" type "$SESSION_ID" --json 'exit'
run_json 'tui-send-enter-exit.json' "${CLI[@]}" --home "$SESSION_HOME" send-keys "$SESSION_ID" --json Enter
run_json 'tui-wait-exit.json' "${CLI[@]}" --home "$SESSION_HOME" wait "$SESSION_ID" --json --exit
run_json 'tui-inspect-final.json' "${CLI[@]}" --home "$SESSION_HOME" inspect "$SESSION_ID" --json
run_json 'tui-record-export-cast.json' "${CLI[@]}" --home "$SESSION_HOME" record export "$SESSION_ID" --format asciicast --out "$CAST_PATH" --json
run_json 'tui-record-export-webm.json' "${CLI[@]}" --home "$SESSION_HOME" record export "$SESSION_ID" --format webm --out "$WEBM_PATH" --json
run_json 'tui-destroy.json' "${CLI[@]}" --home "$SESSION_HOME" destroy "$SESSION_ID" --json
rm -rf "$SESSION_HOME"
SESSION_HOME=""

assert_file "$SCREENSHOT_DEST_PATH"
assert_file "$CAST_PATH"
assert_file "$WEBM_PATH"

node --input-type=module - "$BUNDLE_DIR" <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const bundleDir = process.argv[2];
const requiredJsonFiles = [
  'skills-list.json',
  'skills-get-agent-tty.json',
  'skills-get-dogfood-tui.json',
  'skills-path-agent-tty.json',
  'skills-path-dogfood-tui.json',
  'tui-doctor.json',
  'tui-create.json',
  'tui-wait-ready.json',
  'tui-type-agent.json',
  'tui-send-enter.json',
  'tui-wait-echo.json',
  'tui-wait-stable.json',
  'tui-snapshot-text.json',
  'tui-screenshot-echo.json',
  'tui-type-exit.json',
  'tui-send-enter-exit.json',
  'tui-wait-exit.json',
  'tui-inspect-final.json',
  'tui-record-export-cast.json',
  'tui-record-export-webm.json',
  'tui-destroy.json',
];
for (const file of requiredJsonFiles) {
  const payload = JSON.parse(fs.readFileSync(path.join(bundleDir, file), 'utf8'));
  assert.equal(payload.ok, true, `${file} should report ok=true`);
}
const skillsList = JSON.parse(fs.readFileSync(path.join(bundleDir, 'skills-list.json'), 'utf8'));
const skillNames = new Set(skillsList.result.skills.map((skill) => skill.name));
assert(skillNames.has('agent-tty'), 'skills list should include agent-tty');
assert(skillNames.has('dogfood-tui'), 'skills list should include dogfood-tui');
const agentTty = JSON.parse(fs.readFileSync(path.join(bundleDir, 'skills-get-agent-tty.json'), 'utf8'));
const dogfoodTui = JSON.parse(fs.readFileSync(path.join(bundleDir, 'skills-get-dogfood-tui.json'), 'utf8'));
assert(agentTty.result.path.endsWith('/skill-data/agent-tty/SKILL.md'), 'agent-tty runtime skill should come from skill-data');
assert(dogfoodTui.result.path.endsWith('/skill-data/dogfood-tui/SKILL.md'), 'dogfood-tui runtime skill should come from skill-data');
assert.equal(agentTty.result.content, fs.readFileSync(agentTty.result.path, 'utf8'), 'agent-tty content should match runtime skill file');
assert.equal(dogfoodTui.result.content, fs.readFileSync(dogfoodTui.result.path, 'utf8'), 'dogfood-tui content should match runtime skill file');
const agentTtyPath = JSON.parse(fs.readFileSync(path.join(bundleDir, 'skills-path-agent-tty.json'), 'utf8'));
const dogfoodTuiPath = JSON.parse(fs.readFileSync(path.join(bundleDir, 'skills-path-dogfood-tui.json'), 'utf8'));
assert(agentTtyPath.result.path.endsWith('/skill-data/agent-tty'), 'skills path agent-tty should resolve to runtime directory');
assert(dogfoodTuiPath.result.path.endsWith('/skill-data/dogfood-tui'), 'skills path dogfood-tui should resolve to runtime directory');
const npmPackPaths = fs.readFileSync(path.join(bundleDir, 'npm-pack-skill-files.txt'), 'utf8').trim().split(/\n+/);
for (const expectedPath of [
  'skills/agent-tty/SKILL.md',
  'skill-data/agent-tty/SKILL.md',
  'skill-data/dogfood-tui/SKILL.md',
]) {
  assert(npmPackPaths.includes(expectedPath), `npm pack file list should include ${expectedPath}`);
}
const screenshotPath = path.join(bundleDir, 'screenshots', 'hello-prompt-echo.png');
const screenshotBuffer = fs.readFileSync(screenshotPath);
assert(screenshotBuffer.byteLength > 1024, 'screenshot should be larger than 1KB');
assert.equal(screenshotBuffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'screenshot should have PNG signature');
for (const recordingPath of [
  path.join(bundleDir, 'recordings', 'hello-prompt.cast'),
  path.join(bundleDir, 'recordings', 'hello-prompt.webm'),
]) {
  const stats = fs.statSync(recordingPath);
  assert(stats.size > 0, `${path.basename(recordingPath)} should be non-empty`);
}
NODE
log_step 'validate-bundle' 0 "node --input-type=module <bundle-validation>"

cat > "$BUNDLE_DIR/manifest.json" <<EOF_MANIFEST
{
  "bundle": "20260413-skills-runtime-refactor",
  "description": "Skills runtime refactor validation",
  "date": "2026-04-13",
  "gitCommit": "$GIT_COMMIT",
  "notes": "notes.md",
  "commands": "commands.sh",
  "commandLog": "command-log.tsv",
  "artifacts": {
    "skills-list.json": "skills list --json output",
    "skills-get-agent-tty.json": "skills get agent-tty --json output",
    "skills-get-dogfood-tui.json": "skills get dogfood-tui --json output",
    "skills-path-agent-tty.json": "skills path agent-tty --json output",
    "skills-path-dogfood-tui.json": "skills path dogfood-tui --json output",
    "npm-pack-skill-files.txt": "skill-related files in npm pack --json --dry-run output",
    "tui-doctor.json": "doctor --json output for the isolated dogfood session",
    "tui-create.json": "session creation output for the hello-prompt fixture",
    "tui-wait-ready.json": "wait output for the READY prompt",
    "tui-snapshot-text.json": "text snapshot after submitting Agent",
    "tui-screenshot-echo.json": "screenshot command output for the echoed prompt",
    "tui-record-export-cast.json": "asciicast export output",
    "tui-record-export-webm.json": "webm export output",
    "tui-inspect-final.json": "inspect output after the fixture exited",
    "screenshots/hello-prompt-echo.png": "copied screenshot proof from the isolated session",
    "recordings/hello-prompt.cast": "asciicast recording of the dogfood-tui flow",
    "recordings/hello-prompt.webm": "webm recording of the dogfood-tui flow",
    "session-id.txt": "captured session ID",
    "agent-tty-home.txt": "temporary isolated home path used for the session"
  }
}
EOF_MANIFEST
log_step 'manifest.json' 0 "write $BUNDLE_DIR/manifest.json"

python3 - "$BUNDLE_DIR" "$CLI_NODE_VERSION" "$NPM_VERSION" "$GIT_COMMIT" "$SKILLS_LIST_PATH" "$SKILLS_GET_AGENT_TTY_PATH" "$SKILLS_GET_DOGFOOD_TUI_PATH" "$SKILLS_PATH_AGENT_TTY_DIR" "$SKILLS_PATH_DOGFOOD_TUI_DIR" <<'PY_NOTES'
from pathlib import Path
import sys

bundle_dir = Path(sys.argv[1])
cli_node_version = sys.argv[2]
npm_version = sys.argv[3]
git_commit = sys.argv[4]
skills_list_path = sys.argv[5]
skills_get_agent_tty_path = sys.argv[6]
skills_get_dogfood_tui_path = sys.argv[7]
skills_path_agent_tty_dir = sys.argv[8]
skills_path_dogfood_tui_dir = sys.argv[9]
session_id = (bundle_dir / 'session-id.txt').read_text(encoding='utf-8').strip()
isolated_home = (bundle_dir / 'agent-tty-home.txt').read_text(encoding='utf-8').strip()

notes = f"""# Skills runtime refactor proof bundle

- **Date:** 2026-04-13
- **Bundle:** `dogfood/20260413-skills-runtime-refactor/`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **CLI Node:** `{cli_node_version}`
- **npm:** `{npm_version}`
- **Git commit:** `{git_commit}`
- **Isolated home:** `{isolated_home}` (cleaned up after `tui-destroy.json`)
- **Session ID:** `{session_id}`
- **Fixture:** `npx tsx test/fixtures/apps/hello-prompt/main.ts`

## What was validated

1. **Skills CLI surface** — `skills list`, `skills get`, and `skills path` all returned successful JSON envelopes with `\"ok\": true`.
2. **Bundled skills discovery** — `skills-list.json` lists both `agent-tty` and `dogfood-tui`.
3. **Runtime skill resolution** — `skills get` and `skills path` both resolve to `skill-data/`, proving the runtime CLI serves the canonical bundled skill files rather than the thin bootstrap under `skills/`.
4. **Tarball packaging** — `npm-pack-skill-files.txt` shows both `skills/agent-tty/SKILL.md` and the runtime `skill-data/` entries are included in `npm pack --json --dry-run`.
5. **dogfood-tui workflow** — the isolated `hello-prompt` session followed the dogfood skill pattern: `doctor`, `create`, `wait`, `type`, `send-keys`, `snapshot`, `screenshot`, `record export`, `inspect`, and `destroy`.

## Key runtime paths

- `skills-list.json` reported bundled entries for both `agent-tty` and `dogfood-tui`
- `skills-get-agent-tty.json` resolved to `{skills_get_agent_tty_path}`
- `skills-get-dogfood-tui.json` resolved to `{skills_get_dogfood_tui_path}`
- `skills-path-agent-tty.json` resolved to `{skills_path_agent_tty_dir}`
- `skills-path-dogfood-tui.json` resolved to `{skills_path_dogfood_tui_dir}`

## TUI proof artifacts

- `tui-snapshot-text.json` — searchable text proof of the echoed `Agent` response
- `tui-screenshot-echo.json` + `screenshots/hello-prompt-echo.png` — visual proof of the prompt and echoed input
- `tui-record-export-cast.json` + `recordings/hello-prompt.cast` — asciicast replay of the session
- `tui-record-export-webm.json` + `recordings/hello-prompt.webm` — WebM replay of the session
- `tui-inspect-final.json` — confirms the fixture exited before destroy
- `command-log.tsv` — exact commands run, including the screenshot copy and validation step

## Expected vs actual

Expected: the refactored `skills list/get/path` surface should expose bundled runtime skills from `skill-data/`, `npm pack --json --dry-run` should include both `skills/` and `skill-data/`, and the new `dogfood-tui` workflow should produce reviewable screenshot and recording artifacts.

Actual: all required command envelopes parsed successfully with `\"ok\": true`; `skills list` included both bundled skills; `skills get` content matched the on-disk `skill-data/*/SKILL.md` files byte-for-byte; `skills path` resolved to the runtime `skill-data/<name>` directories; `npm pack --json --dry-run` listed both the bootstrap `skills/agent-tty/SKILL.md` file and the runtime `skill-data/` copies; and the `hello-prompt` dogfood run produced a non-empty PNG screenshot plus both `.cast` and `.webm` recordings.
"""

(bundle_dir / 'notes.md').write_text(notes, encoding='utf-8')
PY_NOTES
log_step 'notes.md' 0 "python3 <write-notes>"
