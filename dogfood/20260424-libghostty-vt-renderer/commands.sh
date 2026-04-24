#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BUNDLE_DIR="$SCRIPT_DIR"
SCREENSHOTS_DIR="$BUNDLE_DIR/screenshots"
RECORDINGS_DIR="$BUNDLE_DIR/recordings"
VIDEOS_DIR="$BUNDLE_DIR/videos"
CLI=(npx tsx src/cli/main.ts)
CLI_WITH_TIMEOUT=(npx tsx src/cli/main.ts --timeout-ms 120000)
FIXTURE=(npx tsx test/fixtures/apps/hello-prompt/main.ts)
PROMPT_TEXT='READY>'
ECHO_TEXT='Phase 6 renderer proof'
AGENT_TTY_HOME="$(mktemp -d -t agent-tty-dogfood.XXXXXX)"
export AGENT_TTY_HOME
GHOSTTY_WEB_SESSION_ID=''
LIBGHOSTTY_VT_SESSION_ID=''

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

assert_file_nonempty() {
  local path="$1"
  [[ -s "$path" ]] || {
    printf 'expected non-empty file: %s\n' "$path" >&2
    exit 1
  }
}

run_json_file() {
  local output_path="$1"
  shift
  local tmp_path="$output_path.tmp"
  "$@" > "$tmp_path"
  jq . "$tmp_path" > "$output_path"
  rm -f "$tmp_path"
  jq -e '.ok == true' "$output_path" >/dev/null
}

capture_json_var() {
  local __resultvar="$1"
  shift
  local raw_json
  local pretty_json
  raw_json="$($@)"
  pretty_json="$(printf '%s\n' "$raw_json" | jq .)"
  printf '%s\n' "$pretty_json" | jq -e '.ok == true' >/dev/null
  printf -v "$__resultvar" '%s' "$pretty_json"
}

run_json_check_only() {
  "$@" | jq -e '.ok == true' >/dev/null
}

cleanup() {
  local exit_code=$?
  set +e
  if [[ -n "${GHOSTTY_WEB_SESSION_ID:-}" ]]; then
    "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" destroy "$GHOSTTY_WEB_SESSION_ID" --json >/dev/null 2>&1 || true
  fi
  if [[ -n "${LIBGHOSTTY_VT_SESSION_ID:-}" ]]; then
    "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" destroy "$LIBGHOSTTY_VT_SESSION_ID" --json >/dev/null 2>&1 || true
  fi
  if [[ -n "${AGENT_TTY_HOME:-}" && -d "${AGENT_TTY_HOME:-}" ]]; then
    rm -rf "$AGENT_TTY_HOME"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

require_command git
require_command jq
require_command node
require_command npm
require_command npx
require_command uname

mkdir -p "$SCREENSHOTS_DIR" "$RECORDINGS_DIR" "$VIDEOS_DIR"
rm -f "$BUNDLE_DIR"/*.json "$BUNDLE_DIR/environment.txt"
rm -f "$SCREENSHOTS_DIR"/*.png "$RECORDINGS_DIR"/*.cast "$VIDEOS_DIR"/*.webm

cd "$REPO_ROOT"

# Capture native addon metadata before any renderer run. Import failure means the
# optional libghostty-vt dependency is unavailable in this workspace.
node --input-type=module > "$BUNDLE_DIR/native-info.json" <<'NODE'
const { getNativeInfo } = await import('@coder/libghostty-vt-node');
console.log(JSON.stringify(getNativeInfo(), null, 2));
NODE
jq -e '.packageVersion and .ghosttyVersion and .platform and .arch' "$BUNDLE_DIR/native-info.json" >/dev/null

# Capture environment details without secrets. The root --version form is
# included because it was requested for this proof bundle; this CLI currently
# exposes the machine-readable version through `version --json`.
{
  printf '$ node --version\n%s\n\n' "$(node --version)"
  printf '$ npm --version\n%s\n\n' "$(npm --version)"
  printf '$ git rev-parse HEAD\n%s\n\n' "$(git rev-parse HEAD)"
  printf '$ git log --oneline -n 1\n%s\n\n' "$(git log --oneline -n 1)"
  printf '$ uname -a\n%s\n\n' "$(uname -a)"
  printf '$ npx tsx src/cli/main.ts --version\n'
  if version_output="$("${CLI[@]}" --version 2>&1)"; then
    printf '%s\n\n' "$version_output"
  else
    printf '%s\n' "$version_output"
    printf '(command exited non-zero; use `npx tsx src/cli/main.ts version --json` for this CLI)\n\n'
  fi
  printf '$ npx tsx src/cli/main.ts version --json\n'
  "${CLI[@]}" version --json | jq .
  printf '\n$ node --input-type=module -e "import getNativeInfo"\n'
  cat "$BUNDLE_DIR/native-info.json"
} > "$BUNDLE_DIR/environment.txt"

# Sanity check the isolated home before starting proof sessions. This is not
# retained as a bundle artifact because the reviewer-facing proof is the two
# renderer runs below.
"${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" doctor --json | jq -e '.ok == true and .result.ok == true' >/dev/null

# Ghostty-web baseline: run the hello-prompt fixture, drive the same short input
# as the native run, then capture wait/snapshot/screenshot envelopes.
GHOSTTY_CREATE_JSON=''
capture_json_var \
  GHOSTTY_CREATE_JSON \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  create --json --cwd "$REPO_ROOT" --cols 80 --rows 24 --name phase6-ghostty-web -- "${FIXTURE[@]}"
GHOSTTY_WEB_SESSION_ID="$(printf '%s\n' "$GHOSTTY_CREATE_JSON" | jq -er '.result.sessionId')"
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  wait "$GHOSTTY_WEB_SESSION_ID" --json --text "$PROMPT_TEXT" --timeout 10000
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  type "$GHOSTTY_WEB_SESSION_ID" --json "$ECHO_TEXT"
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  send-keys "$GHOSTTY_WEB_SESSION_ID" --json Enter
run_json_file \
  "$BUNDLE_DIR/ghostty-web-wait.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  wait "$GHOSTTY_WEB_SESSION_ID" --json --text "ECHO: $ECHO_TEXT" --timeout 10000
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  wait "$GHOSTTY_WEB_SESSION_ID" --json --screen-stable-ms 250 --timeout 10000
run_json_file \
  "$BUNDLE_DIR/ghostty-web-snapshot.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  snapshot "$GHOSTTY_WEB_SESSION_ID" --format text --json
run_json_file \
  "$BUNDLE_DIR/ghostty-web-screenshot.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web \
  screenshot "$GHOSTTY_WEB_SESSION_ID" --hide-cursor --json
GHOSTTY_SCREENSHOT_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/ghostty-web-screenshot.json")"
assert_file_nonempty "$GHOSTTY_SCREENSHOT_SOURCE"
cp "$GHOSTTY_SCREENSHOT_SOURCE" "$SCREENSHOTS_DIR/ghostty-web.png"
assert_file_nonempty "$SCREENSHOTS_DIR/ghostty-web.png"
jq -e '.result.rendererBackend == "ghostty-web"' "$BUNDLE_DIR/ghostty-web-screenshot.json" >/dev/null
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" \
  destroy "$GHOSTTY_WEB_SESSION_ID" --json
GHOSTTY_WEB_SESSION_ID=''

# Libghostty-vt run: semantic wait/snapshot use the selected native backend;
# screenshot and WebM are intentionally produced by the ghostty-web fallback.
LIB_CREATE_JSON=''
capture_json_var \
  LIB_CREATE_JSON \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  create --json --cwd "$REPO_ROOT" --cols 80 --rows 24 --name phase6-libghostty-vt -- "${FIXTURE[@]}"
LIBGHOSTTY_VT_SESSION_ID="$(printf '%s\n' "$LIB_CREATE_JSON" | jq -er '.result.sessionId')"
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  wait "$LIBGHOSTTY_VT_SESSION_ID" --json --text "$PROMPT_TEXT" --timeout 10000
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  type "$LIBGHOSTTY_VT_SESSION_ID" --json "$ECHO_TEXT"
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  send-keys "$LIBGHOSTTY_VT_SESSION_ID" --json Enter
run_json_file \
  "$BUNDLE_DIR/libghostty-vt-wait.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  wait "$LIBGHOSTTY_VT_SESSION_ID" --json --text "ECHO: $ECHO_TEXT" --timeout 10000
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  wait "$LIBGHOSTTY_VT_SESSION_ID" --json --screen-stable-ms 250 --timeout 10000
run_json_file \
  "$BUNDLE_DIR/libghostty-vt-snapshot.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  snapshot "$LIBGHOSTTY_VT_SESSION_ID" --format text --json
run_json_file \
  "$BUNDLE_DIR/libghostty-vt-screenshot.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  screenshot "$LIBGHOSTTY_VT_SESSION_ID" --hide-cursor --json
LIB_SCREENSHOT_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/libghostty-vt-screenshot.json")"
assert_file_nonempty "$LIB_SCREENSHOT_SOURCE"
cp "$LIB_SCREENSHOT_SOURCE" "$SCREENSHOTS_DIR/libghostty-vt-fallback.png"
assert_file_nonempty "$SCREENSHOTS_DIR/libghostty-vt-fallback.png"
jq -e '.result.rendererBackend == "ghostty-web"' "$BUNDLE_DIR/libghostty-vt-screenshot.json" >/dev/null

# End the fixture cleanly, then export both recording formats from the native run.
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  type "$LIBGHOSTTY_VT_SESSION_ID" --json 'exit'
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  send-keys "$LIBGHOSTTY_VT_SESSION_ID" --json Enter
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  wait "$LIBGHOSTTY_VT_SESSION_ID" --json --exit --timeout 10000
run_json_file \
  "$BUNDLE_DIR/libghostty-vt-record-cast.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  record export "$LIBGHOSTTY_VT_SESSION_ID" --format asciicast --json
CAST_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/libghostty-vt-record-cast.json")"
assert_file_nonempty "$CAST_SOURCE"
cp "$CAST_SOURCE" "$RECORDINGS_DIR/terminal-session.cast"
run_json_file \
  "$BUNDLE_DIR/libghostty-vt-record-webm.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  record export "$LIBGHOSTTY_VT_SESSION_ID" --format webm --json
WEBM_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/libghostty-vt-record-webm.json")"
assert_file_nonempty "$WEBM_SOURCE"
cp "$WEBM_SOURCE" "$VIDEOS_DIR/libghostty-vt-fallback.webm"
assert_file_nonempty "$RECORDINGS_DIR/terminal-session.cast"
assert_file_nonempty "$VIDEOS_DIR/libghostty-vt-fallback.webm"
jq -e '.result.format == "asciicast"' "$BUNDLE_DIR/libghostty-vt-record-cast.json" >/dev/null
jq -e '.result.metadata.rendererBackend == "ghostty-web"' "$BUNDLE_DIR/libghostty-vt-record-webm.json" >/dev/null
node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trimEnd().split(/\r?\n/);
if (lines.length === 0) throw new Error("empty asciicast");
JSON.parse(lines[0]);
for (const line of lines.slice(1)) JSON.parse(line);
' "$RECORDINGS_DIR/terminal-session.cast"

run_json_file \
  "$BUNDLE_DIR/inspect.json" \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt \
  inspect "$LIBGHOSTTY_VT_SESSION_ID" --json
run_json_check_only \
  "${CLI_WITH_TIMEOUT[@]}" --home "$AGENT_TTY_HOME" \
  destroy "$LIBGHOSTTY_VT_SESSION_ID" --json
LIBGHOSTTY_VT_SESSION_ID=''

# Both screenshots are generated by ghostty-web from identical terminal content.
# A byte-for-byte comparison keeps this proof objective and reviewer-repeatable.
cmp -s "$SCREENSHOTS_DIR/ghostty-web.png" "$SCREENSHOTS_DIR/libghostty-vt-fallback.png"

# Top-level CLI envelopes should report ok=true. native-info.json is intentionally
# not a CLI envelope, so it is excluded from this assertion.
for json_file in "$BUNDLE_DIR"/*.json; do
  if [[ "$(basename "$json_file")" == 'native-info.json' ]]; then
    continue
  fi
  jq -e '.ok == true' "$json_file" >/dev/null
done

trap - EXIT
rm -rf "$AGENT_TTY_HOME"
unset AGENT_TTY_HOME
