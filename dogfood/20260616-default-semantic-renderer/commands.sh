#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BUNDLE_DIR="$SCRIPT_DIR"
SCREENSHOTS_DIR="$BUNDLE_DIR/screenshots"
VIDEOS_DIR="$BUNDLE_DIR/videos"
RECORDINGS_DIR="$BUNDLE_DIR/recordings"
CLI=(npx tsx src/cli/main.ts --timeout-ms 120000)
FIXTURE=(npx tsx test/fixtures/apps/hello-prompt/main.ts)
PROMPT_TEXT='READY>'
ECHO_TEXT='Default semantic renderer proof'
AGENT_TTY_HOME="$(mktemp -d -t agent-tty-default-renderer.XXXXXX)"
export AGENT_TTY_HOME
SESSION_ID=''

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

session_dir() {
  printf '%s/sessions/%s\n' "$AGENT_TTY_HOME" "$SESSION_ID"
}

artifact_manifest_path() {
  printf '%s/artifacts/manifest.json\n' "$(session_dir)"
}

copy_artifact_manifest() {
  jq . "$(artifact_manifest_path)" > "$BUNDLE_DIR/artifact-manifest.json"
}

write_latest_artifact() {
  local kind="$1"
  local output_path="$2"
  jq --arg kind "$kind" '
    .artifacts | map(select(.kind == $kind)) | last
  ' "$(artifact_manifest_path)" > "$output_path"
}

assert_latest_artifact_backend() {
  local kind="$1"
  local expected_backend="$2"
  jq -e --arg kind "$kind" --arg backend "$expected_backend" '
    (.artifacts | map(select(.kind == $kind)) | last | .metadata.rendererBackend) == $backend
  ' "$(artifact_manifest_path)" >/dev/null
}

cleanup() {
  local exit_code=$?
  set +e
  if [[ -n "${SESSION_ID:-}" ]]; then
    "${CLI[@]}" --home "$AGENT_TTY_HOME" destroy "$SESSION_ID" --json >/dev/null 2>&1 || true
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

mkdir -p "$SCREENSHOTS_DIR" "$VIDEOS_DIR" "$RECORDINGS_DIR"
rm -f "$BUNDLE_DIR"/*.json "$BUNDLE_DIR/environment.txt"
rm -f "$SCREENSHOTS_DIR"/*.png "$VIDEOS_DIR"/*.webm "$RECORDINGS_DIR"/*.cast

cd "$REPO_ROOT"

EXPECTED_SEMANTIC_RENDERER="$({
  node --input-type=module <<'NODE'
try {
  const mod = await import('@coder/libghostty-vt-node');
  if (typeof mod.createTerminal === 'function') {
    console.log('libghostty-vt');
  } else {
    console.log('ghostty-web');
  }
} catch {
  console.log('ghostty-web');
}
NODE
} | tail -n 1)"
printf '{"expectedSemanticRenderer":"%s"}\n' "$EXPECTED_SEMANTIC_RENDERER" | jq . > "$BUNDLE_DIR/expected-renderer.json"

{
  printf '$ node --version\n%s\n\n' "$(node --version)"
  printf '$ npm --version\n%s\n\n' "$(npm --version)"
  printf '$ git rev-parse HEAD\n%s\n\n' "$(git rev-parse HEAD)"
  printf '$ git log --oneline -n 1\n%s\n\n' "$(git log --oneline -n 1)"
  printf '$ uname -a\n%s\n\n' "$(uname -a)"
  printf '$ expected semantic renderer\n%s\n\n' "$EXPECTED_SEMANTIC_RENDERER"
  printf '$ npx tsx src/cli/main.ts version --json\n'
  "${CLI[@]}" version --json | jq .
  printf '\n$ npx tsx src/cli/main.ts doctor --json\n'
  "${CLI[@]}" --home "$AGENT_TTY_HOME" doctor --json | jq .
} > "$BUNDLE_DIR/environment.txt"

run_json_file "$BUNDLE_DIR/version.json" "${CLI[@]}" version --json
run_json_file "$BUNDLE_DIR/doctor.json" "${CLI[@]}" --home "$AGENT_TTY_HOME" doctor --json

CREATE_JSON=''
capture_json_var \
  CREATE_JSON \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" create --json --cwd "$REPO_ROOT" \
  --cols 80 --rows 24 --name default-semantic-renderer -- "${FIXTURE[@]}"
SESSION_ID="$(printf '%s\n' "$CREATE_JSON" | jq -er '.result.sessionId')"
printf '%s\n' "$CREATE_JSON" > "$BUNDLE_DIR/create.json"

run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" wait "$SESSION_ID" --json --text "$PROMPT_TEXT" --timeout 10000
run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" type "$SESSION_ID" --json "$ECHO_TEXT"
run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" send-keys "$SESSION_ID" --json Enter
run_json_file "$BUNDLE_DIR/default-wait.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" wait "$SESSION_ID" --json --text "ECHO: $ECHO_TEXT" --timeout 10000
run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" wait "$SESSION_ID" --json --screen-stable-ms 250 --timeout 10000

run_json_file "$BUNDLE_DIR/default-snapshot.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" snapshot "$SESSION_ID" --format structured --json
assert_latest_artifact_backend snapshot "$EXPECTED_SEMANTIC_RENDERER"
write_latest_artifact snapshot "$BUNDLE_DIR/default-snapshot-artifact.json"

run_json_file "$BUNDLE_DIR/default-screenshot.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" screenshot "$SESSION_ID" --hide-cursor --json
jq -e '.result.rendererBackend == "ghostty-web"' "$BUNDLE_DIR/default-screenshot.json" >/dev/null
DEFAULT_SCREENSHOT_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/default-screenshot.json")"
assert_file_nonempty "$DEFAULT_SCREENSHOT_SOURCE"
cp "$DEFAULT_SCREENSHOT_SOURCE" "$SCREENSHOTS_DIR/default-screenshot.png"
assert_file_nonempty "$SCREENSHOTS_DIR/default-screenshot.png"

run_json_file "$BUNDLE_DIR/explicit-ghostty-web-snapshot.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" --renderer ghostty-web snapshot "$SESSION_ID" --format text --json
assert_latest_artifact_backend snapshot ghostty-web
write_latest_artifact snapshot "$BUNDLE_DIR/explicit-ghostty-web-snapshot-artifact.json"

run_json_file "$BUNDLE_DIR/explicit-libghostty-vt-screenshot.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt screenshot "$SESSION_ID" --hide-cursor --json
jq -e '.result.rendererBackend == "ghostty-web"' "$BUNDLE_DIR/explicit-libghostty-vt-screenshot.json" >/dev/null
EXPLICIT_SCREENSHOT_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/explicit-libghostty-vt-screenshot.json")"
assert_file_nonempty "$EXPLICIT_SCREENSHOT_SOURCE"
cp "$EXPLICIT_SCREENSHOT_SOURCE" "$SCREENSHOTS_DIR/explicit-libghostty-vt-screenshot.png"
assert_file_nonempty "$SCREENSHOTS_DIR/explicit-libghostty-vt-screenshot.png"

run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" type "$SESSION_ID" --json 'exit'
run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" send-keys "$SESSION_ID" --json Enter
run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" wait "$SESSION_ID" --json --exit --timeout 10000

run_json_file "$BUNDLE_DIR/default-webm.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" record export "$SESSION_ID" --format webm --timing accelerated --json
jq -e '.result.metadata.rendererBackend == "ghostty-web"' "$BUNDLE_DIR/default-webm.json" >/dev/null
DEFAULT_WEBM_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/default-webm.json")"
assert_file_nonempty "$DEFAULT_WEBM_SOURCE"
cp "$DEFAULT_WEBM_SOURCE" "$VIDEOS_DIR/default-webm.webm"
assert_file_nonempty "$VIDEOS_DIR/default-webm.webm"

run_json_file "$BUNDLE_DIR/explicit-libghostty-vt-webm.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" --renderer libghostty-vt record export "$SESSION_ID" --format webm --timing accelerated --json
jq -e '.result.metadata.rendererBackend == "ghostty-web"' "$BUNDLE_DIR/explicit-libghostty-vt-webm.json" >/dev/null
EXPLICIT_WEBM_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/explicit-libghostty-vt-webm.json")"
assert_file_nonempty "$EXPLICIT_WEBM_SOURCE"
cp "$EXPLICIT_WEBM_SOURCE" "$VIDEOS_DIR/explicit-libghostty-vt-webm.webm"
assert_file_nonempty "$VIDEOS_DIR/explicit-libghostty-vt-webm.webm"

run_json_file "$BUNDLE_DIR/default-cast.json" \
  "${CLI[@]}" --home "$AGENT_TTY_HOME" record export "$SESSION_ID" --format asciicast --json
CAST_SOURCE="$(jq -er '.result.artifactPath' "$BUNDLE_DIR/default-cast.json")"
assert_file_nonempty "$CAST_SOURCE"
cp "$CAST_SOURCE" "$RECORDINGS_DIR/default.cast"
assert_file_nonempty "$RECORDINGS_DIR/default.cast"

run_json_file "$BUNDLE_DIR/inspect.json" "${CLI[@]}" --home "$AGENT_TTY_HOME" inspect "$SESSION_ID" --json
copy_artifact_manifest

file "$SCREENSHOTS_DIR"/*.png > "$BUNDLE_DIR/artifact-file-info.txt"
file "$VIDEOS_DIR"/*.webm >> "$BUNDLE_DIR/artifact-file-info.txt"
file "$RECORDINGS_DIR"/*.cast >> "$BUNDLE_DIR/artifact-file-info.txt"
sha256sum "$SCREENSHOTS_DIR"/*.png "$VIDEOS_DIR"/*.webm "$RECORDINGS_DIR"/*.cast > "$BUNDLE_DIR/artifact-sha256.txt"

run_json_check_only "${CLI[@]}" --home "$AGENT_TTY_HOME" destroy "$SESSION_ID" --json
SESSION_ID=''

printf 'dogfood bundle written to %s\n' "$BUNDLE_DIR"
