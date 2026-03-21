#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  mise_shell_env="$(mise activate bash 2>/dev/null || true)"
  if [[ -n "$mise_shell_env" ]]; then
    eval "$mise_shell_env"
  fi
  mise_node="$(mise which node 2>/dev/null || true)"
  if [[ -n "$mise_node" ]]; then
    export PATH="$(dirname "$mise_node"):$PATH"
  fi
fi

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"
export PATH="$ROOT_DIR/node_modules/.bin:$PATH"

CLI=(tsx src/cli/main.ts)
BUNDLE_A="dogfood/20260321-week3-renderer-complete"
BUNDLE_B="dogfood/20260321-week3-crash-retention"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-terminal-week3-bundles.XXXXXX")"
RUN_TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
NODE_VERSION="$(node -v)"
PLATFORM="$(uname -srmo 2>/dev/null || uname -a)"

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

quote_command() {
  printf '%q ' "$@"
  printf '\n'
}

new_home() {
  mktemp -d "$TEMP_ROOT/home.XXXXXX"
}

json_eval() {
  local file="$1"
  local expression="$2"
  node - "$file" "$expression" <<'NODE'
const fs = require('fs');
const [file, expression] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
let value;
try {
  value = Function('data', `return (${expression});`)(data);
} catch (error) {
  console.error(`json_eval failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (value === undefined) {
  process.exit(2);
}
if (typeof value === 'string') {
  process.stdout.write(value);
} else {
  process.stdout.write(JSON.stringify(value));
}
NODE
}

assert_json_true() {
  local file="$1"
  local expression="$2"
  local message="$3"
  node - "$file" "$expression" "$message" <<'NODE'
const fs = require('fs');
const [file, expression, message] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
let value;
try {
  value = Function('data', `return (${expression});`)(data);
} catch (error) {
  console.error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (value !== true) {
  console.error(`${message}: expression evaluated to ${JSON.stringify(value)}`);
  process.exit(1);
}
NODE
}

assert_doctor_ok() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (data.ok !== true || data.result?.ok !== true) {
  console.error(`doctor failed: ${file}`);
  process.exit(1);
}
const groups = Object.values(data.result.checks ?? {});
for (const group of groups) {
  for (const check of group) {
    if (check.status !== 'pass') {
      console.error(`doctor check did not pass in ${file}: ${check.name} => ${check.status}`);
      process.exit(1);
    }
  }
}
NODE
}

assert_json_file() {
  local file="$1"
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$file" >/dev/null
}

assert_file_exists() {
  local file="$1"
  [[ -f "$file" ]] || fail "expected file to exist: $file"
}

copy_from_json_path() {
  local json_file="$1"
  local expression="$2"
  local destination="$3"
  local source
  source="$(json_eval "$json_file" "$expression")"
  [[ -f "$source" ]] || fail "expected source artifact to exist: $source"
  cp "$source" "$destination"
}

copy_file() {
  local source="$1"
  local destination="$2"
  [[ -f "$source" ]] || fail "expected source file to exist: $source"
  cp "$source" "$destination"
}

sha256_file() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const file = process.argv[2];
const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
process.stdout.write(hash);
NODE
}

compare_snapshot_text() {
  local live_text_file="$1"
  local post_exit_structured_file="$2"
  node - "$live_text_file" "$post_exit_structured_file" <<'NODE'
const fs = require('fs');
const [liveTextFile, postExitStructuredFile] = process.argv.slice(2);
const liveText = JSON.parse(fs.readFileSync(liveTextFile, 'utf8')).result.text;
const postExitStructured = JSON.parse(fs.readFileSync(postExitStructuredFile, 'utf8')).result.visibleLines.map((line) => line.text).join('\n');
if (liveText !== postExitStructured) {
  console.error('post-exit structured snapshot text did not match live text snapshot');
  process.exit(1);
}
NODE
}

append_command_header() {
  local commands_file="$1"
  local home="$2"
  cat > "$commands_file" <<EOF2
#!/usr/bin/env bash
set -euo pipefail
export PATH="\$HOME/.local/bin:\$PATH"
if command -v mise >/dev/null 2>&1; then
  mise_shell_env="\$(mise activate bash 2>/dev/null || true)"
  if [[ -n "\$mise_shell_env" ]]; then
    eval "\$mise_shell_env"
  fi
  mise_node="\$(mise which node 2>/dev/null || true)"
  if [[ -n "\$mise_node" ]]; then
    export PATH="\$(dirname "\$mise_node"):\$PATH"
  fi
fi
cd $(printf '%q' "$ROOT_DIR")
export PATH="$(printf '%q' "$ROOT_DIR")/node_modules/.bin:\$PATH"
export AGENT_TERMINAL_HOME=$(printf '%q' "$home")

EOF2
}

run_json_command() {
  local commands_file="$1"
  local output_file="$2"
  shift 2
  quote_command "${CLI[@]}" "$@" >> "$commands_file"
  "${CLI[@]}" "$@" > "$output_file"
  assert_json_file "$output_file"
  assert_json_true "$output_file" 'data.ok === true' "command failed: $output_file"
}

run_json_command_retry() {
  local retries="$1"
  local sleep_secs="$2"
  local commands_file="$3"
  local output_file="$4"
  shift 4
  local attempt=1
  while true; do
    if run_json_command "$commands_file" "$output_file" "$@"; then
      return 0
    fi
    if (( attempt >= retries )); then
      return 1
    fi
    printf 'retrying %s (attempt %d/%d)\n' "$output_file" "$(( attempt + 1 ))" "$retries"
    sleep "$sleep_secs"
    attempt=$(( attempt + 1 ))
  done
}

write_bundle_a_notes() {
  local bundle_dir="$1"
  local session_id="$2"
  local home="$3"
  local live_seq="$4"
  local post_exit_seq="$5"
  local live_dark_sha="$6"
  local post_exit_dark_sha="$7"
  local gc_home="$8"
  local gc_session_id="$9"
  local gc_removed_count="${10}"
  local gc_list_count="${11}"
  local screenshot_sha_note='different'
  if [[ "$live_dark_sha" == "$post_exit_dark_sha" ]]; then
    screenshot_sha_note='identical'
  fi
  cat > "$bundle_dir/NOTES.md" <<EOF2
# Week 3 renderer-complete dogfood proof bundle

- **Date:** ${RUN_TIMESTAMP}
- **Bundle:** \`$bundle_dir/\`
- **Renderer session ID:** \`$session_id\`
- **Renderer AGENT_TERMINAL_HOME:** \`$home\`
- **GC demo AGENT_TERMINAL_HOME:** \`$gc_home\`
- **Environment:** Node \`$NODE_VERSION\` on \`$PLATFORM\`
- **Headless note:** This bundle was collected in a headless environment, so the reviewer evidence is the CLI JSON envelopes, copied PNG screenshots, copied snapshot artifacts, exported asciicast/WebM recordings, and copied session manifests/event logs.

## Artifacts

| File | Description |
| --- | --- |
| \`commands.sh\` | Exact shell commands used to generate the renderer-complete bundle. |
| \`agent-terminal-home.txt\` | The isolated home used for the renderer-complete scenario. |
| \`session-id.txt\` | Session ID for the main renderer scenario. |
| \`doctor.json\` | \`doctor --json\` output proving all environment and renderer checks passed. |
| \`create-output.json\` | Session creation result for the live renderer session. |
| \`wait-text.json\` | \`wait --text 'Ready'\` result proving renderer-visible content appeared. |
| \`type-output.json\` | \`type\` result for the live interaction. |
| \`wait-regex.json\` | Renderer regex wait proving the typed text became visible in the live terminal. |
| \`snapshot-structured-live.json\` | Live structured snapshot JSON envelope. |
| \`snapshot-text-live.json\` | Live text snapshot JSON envelope. |
| \`screenshot-dark-live.json\` | Live dark-profile screenshot JSON envelope. |
| \`screenshot-light-live.json\` | Live light-profile screenshot JSON envelope. |
| \`record-asciicast-live.json\` | Live asciicast export JSON envelope. |
| \`destroy-output.json\` | Session destroy result. |
| \`snapshot-structured-post-exit.json\` | Post-exit structured snapshot JSON envelope proving offline replay. |
| \`screenshot-dark-post-exit.json\` | Post-exit dark screenshot JSON envelope proving offline replay. |
| \`record-webm-post-exit.json\` | Post-exit WebM export JSON envelope proving video export on an exited session. |
| \`manifest.json\` | Final copied artifact manifest from the session home. |
| \`session-manifest.json\` | Final copied session manifest showing the exited session state. |
| \`event-log.jsonl\` | Raw event log copied from the isolated session home. |
| \`artifacts/live-snapshot-structured-artifact.json\` | Snapshot artifact file copied immediately after the live structured snapshot. |
| \`artifacts/live-snapshot-text-artifact.json\` | Snapshot artifact file copied immediately after the live text snapshot. |
| \`artifacts/post-exit-snapshot-structured-artifact.json\` | Snapshot artifact file copied after post-exit offline replay. |
| \`artifacts/live-reference-dark.png\` | Live screenshot PNG copied from the session artifact path. |
| \`artifacts/live-reference-light.png\` | Live light-theme screenshot PNG copied from the session artifact path. |
| \`artifacts/post-exit-reference-dark.png\` | Post-exit screenshot PNG copied from the offline replay artifact path. |
| \`artifacts/session-live.cast\` | Asciicast exported from the still-running session. |
| \`artifacts/session-post-exit.webm\` | WebM exported after the session had already been destroyed. |
| \`gc/commands.sh\` | Exact shell commands used for the GC sub-demo. |
| \`gc/agent-terminal-home.txt\` | Isolated home used only for the GC demo. |
| \`gc/session-id.txt\` | Temporary session ID used for the GC demo. |
| \`gc/create-output.json\` | GC demo session creation result. |
| \`gc/destroy-output.json\` | GC demo destroy result. |
| \`gc/gc-dry-run.json\` | \`gc --dry-run --json\` output showing what would be removed. |
| \`gc/gc.json\` | \`gc --json\` output showing the session was actually removed. |
| \`gc/list-all.json\` | \`list --all --json\` output proving the removed GC session no longer appears. |

## Verification claims

- \`doctor.json\` reports \`ok: true\` and every environment/renderer check has \`status: pass\`.
- \`wait-text.json\` matched the live \`Ready\` line before evidence capture began.
- \`wait-regex.json\` matched the visible \`week3 renderer bundle\` text, so the live recording contains interaction beyond the initial prompt.
- The live text snapshot and the post-exit structured snapshot both capture the same terminal text at sequence \`$live_seq\`, and the post-exit structured snapshot remained at sequence \`$post_exit_seq\` after destroy.
- The live dark screenshot SHA256 is \`$live_dark_sha\` and the post-exit dark screenshot SHA256 is \`$post_exit_dark_sha\`; the files were $screenshot_sha_note, which helps reviewers judge whether offline replay reproduced the exact same frame bytes.
- \`record-asciicast-live.json\` proves asciicast export works on a running session, and \`record-webm-post-exit.json\` proves WebM export works after the session has exited.
- \`manifest.json\` shows the copied snapshot, screenshot, recording, and video artifacts recorded against the renderer session.
- GC dry-run reported \`$gc_removed_count\` removable session(s), the actual GC run removed the temporary session \`$gc_session_id\`, and \`gc/list-all.json\` shows \`$gc_list_count\` remaining session(s) in the isolated GC home.

## Issues encountered

- No blocking issues were encountered during bundle generation.
- WebM export can take longer than the other commands, so the generator script retries WebM export once before failing in order to reduce flake risk.
EOF2
}

write_bundle_b_notes() {
  local bundle_dir="$1"
  local session_id="$2"
  local home="$3"
  local exit_code="$4"
  cat > "$bundle_dir/NOTES.md" <<EOF2
# Week 3 crash-retention dogfood proof bundle

- **Date:** ${RUN_TIMESTAMP}
- **Bundle:** \`$bundle_dir/\`
- **Crash session ID:** \`$session_id\`
- **AGENT_TERMINAL_HOME:** \`$home\`
- **Environment:** Node \`$NODE_VERSION\` on \`$PLATFORM\`
- **Headless note:** Review this bundle via the JSON envelopes plus the copied snapshot/screenshot/recording/video artifacts.

## Artifacts

| File | Description |
| --- | --- |
| \`commands.sh\` | Exact shell commands used to generate the crash-retention bundle. |
| \`agent-terminal-home.txt\` | The isolated home used for the crash-retention scenario. |
| \`session-id.txt\` | Session ID for the crash-retention scenario. |
| \`doctor.json\` | \`doctor --json\` output proving the environment and renderer checks passed before running the crash scenario. |
| \`create-output.json\` | Session creation result for the crashing command. |
| \`wait-exit.json\` | \`wait --exit --json\` result capturing the crash exit code. |
| \`inspect-post-crash.json\` | \`inspect --json\` result showing the session remains persisted after the abnormal exit. |
| \`snapshot-post-crash.json\` | Offline replay snapshot taken after the crash. |
| \`screenshot-post-crash.json\` | Offline replay screenshot taken after the crash. |
| \`record-asciicast-post-crash.json\` | Asciicast export JSON envelope from the crashed session. |
| \`record-webm-post-crash.json\` | WebM export JSON envelope from the crashed session. |
| \`manifest.json\` | Final copied artifact manifest from the crash session home. |
| \`session-manifest.json\` | Copied session manifest showing the persisted exited state and crash metadata. |
| \`event-log.jsonl\` | Raw event log copied from the crash session home. |
| \`artifacts/post-crash-snapshot-structured-artifact.json\` | Snapshot artifact copied after offline replay. |
| \`artifacts/post-crash-reference-dark.png\` | Screenshot PNG copied after offline replay. |
| \`artifacts/session-post-crash.cast\` | Asciicast exported from the crashed session. |
| \`artifacts/session-post-crash.webm\` | WebM exported from the crashed session. |

## Verification claims

- \`doctor.json\` reports \`ok: true\` and all checks passed before the crash scenario ran.
- \`wait-exit.json\` captured exit code \`$exit_code\`, demonstrating non-zero exit retention.
- \`inspect-post-crash.json\` shows the session persisted in \`exited\` state after the abnormal termination rather than disappearing.
- \`snapshot-post-crash.json\` and \`screenshot-post-crash.json\` prove offline replay remained available after the crash.
- \`record-asciicast-post-crash.json\` and \`record-webm-post-crash.json\` prove recording export also remained available after the crash.
- \`manifest.json\`, \`session-manifest.json\`, and \`event-log.jsonl\` preserve the evidence that remained after the process exited non-zero.

## Issues encountered

- No blocking issues were encountered during bundle generation.
- As with the renderer bundle, the generator retries WebM export once before failing because video export is the slowest step.
EOF2
}

write_index() {
  local bundle_dir="$1"
  {
    printf '# Bundle file index\n\n'
    printf 'Generated at `%s`.\n\n' "$RUN_TIMESTAMP"
    printf '```text\n'
    find "$bundle_dir" -type f | sed "s#^$bundle_dir/##" | sort
    printf '```\n'
  } > "$bundle_dir/index.md"
}

require_command git
require_command node
require_command tsx

rm -rf "$BUNDLE_A" "$BUNDLE_B"
mkdir -p "$BUNDLE_A/artifacts" "$BUNDLE_A/gc" "$BUNDLE_B/artifacts"

printf 'Generating %s\n' "$BUNDLE_A"
A_HOME="$(new_home)"
export AGENT_TERMINAL_HOME="$A_HOME"
printf '%s\n' "$A_HOME" > "$BUNDLE_A/agent-terminal-home.txt"
append_command_header "$BUNDLE_A/commands.sh" "$A_HOME"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/doctor.json" doctor --json
assert_doctor_ok "$BUNDLE_A/doctor.json"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/create-output.json" create --json -- /bin/sh -lc 'printf "Loading\n"; sleep 1; printf "3 items\n"; sleep 1; printf "Ready\n"; exec cat'
A_SESSION_ID="$(json_eval "$BUNDLE_A/create-output.json" 'data.result.sessionId')"
printf '%s\n' "$A_SESSION_ID" > "$BUNDLE_A/session-id.txt"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/wait-text.json" wait "$A_SESSION_ID" --text Ready --timeout 20000 --json
assert_json_true "$BUNDLE_A/wait-text.json" 'data.result.timedOut === false' 'wait --text timed out in bundle A'

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/type-output.json" type "$A_SESSION_ID" 'week3 renderer bundle' --json
run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/wait-regex.json" wait "$A_SESSION_ID" --regex 'week3 renderer bundle' --timeout 20000 --json
assert_json_true "$BUNDLE_A/wait-regex.json" 'data.result.timedOut === false' 'wait --regex timed out in bundle A'

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/snapshot-structured-live.json" snapshot "$A_SESSION_ID" --json
LIVE_STRUCTURED_SEQ="$(json_eval "$BUNDLE_A/snapshot-structured-live.json" 'data.result.capturedAtSeq')"
copy_file "$A_HOME/sessions/$A_SESSION_ID/artifacts/snapshot-$LIVE_STRUCTURED_SEQ-structured.json" "$BUNDLE_A/artifacts/live-snapshot-structured-artifact.json"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/snapshot-text-live.json" snapshot "$A_SESSION_ID" --format text --json
LIVE_TEXT_SEQ="$(json_eval "$BUNDLE_A/snapshot-text-live.json" 'data.result.capturedAtSeq')"
copy_file "$A_HOME/sessions/$A_SESSION_ID/artifacts/snapshot-$LIVE_TEXT_SEQ-text.json" "$BUNDLE_A/artifacts/live-snapshot-text-artifact.json"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/screenshot-dark-live.json" screenshot "$A_SESSION_ID" --json
copy_from_json_path "$BUNDLE_A/screenshot-dark-live.json" 'data.result.artifactPath' "$BUNDLE_A/artifacts/live-reference-dark.png"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/screenshot-light-live.json" screenshot "$A_SESSION_ID" --profile reference-light --json
copy_from_json_path "$BUNDLE_A/screenshot-light-live.json" 'data.result.artifactPath' "$BUNDLE_A/artifacts/live-reference-light.png"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/record-asciicast-live.json" record export "$A_SESSION_ID" --format asciicast --out "$BUNDLE_A/artifacts/session-live.cast" --json
assert_file_exists "$BUNDLE_A/artifacts/session-live.cast"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/destroy-output.json" destroy "$A_SESSION_ID" --json

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/snapshot-structured-post-exit.json" snapshot "$A_SESSION_ID" --json
POST_EXIT_SEQ="$(json_eval "$BUNDLE_A/snapshot-structured-post-exit.json" 'data.result.capturedAtSeq')"
copy_file "$A_HOME/sessions/$A_SESSION_ID/artifacts/snapshot-$POST_EXIT_SEQ-structured.json" "$BUNDLE_A/artifacts/post-exit-snapshot-structured-artifact.json"
compare_snapshot_text "$BUNDLE_A/snapshot-text-live.json" "$BUNDLE_A/snapshot-structured-post-exit.json"

run_json_command "$BUNDLE_A/commands.sh" "$BUNDLE_A/screenshot-dark-post-exit.json" screenshot "$A_SESSION_ID" --json
copy_from_json_path "$BUNDLE_A/screenshot-dark-post-exit.json" 'data.result.artifactPath' "$BUNDLE_A/artifacts/post-exit-reference-dark.png"

run_json_command_retry 2 2 "$BUNDLE_A/commands.sh" "$BUNDLE_A/record-webm-post-exit.json" record export "$A_SESSION_ID" --format webm --out "$BUNDLE_A/artifacts/session-post-exit.webm" --json
assert_file_exists "$BUNDLE_A/artifacts/session-post-exit.webm"

copy_file "$A_HOME/sessions/$A_SESSION_ID/artifacts/manifest.json" "$BUNDLE_A/manifest.json"
copy_file "$A_HOME/sessions/$A_SESSION_ID/session.json" "$BUNDLE_A/session-manifest.json"
copy_file "$A_HOME/sessions/$A_SESSION_ID/events.jsonl" "$BUNDLE_A/event-log.jsonl"

LIVE_DARK_SHA="$(sha256_file "$BUNDLE_A/artifacts/live-reference-dark.png")"
POST_EXIT_DARK_SHA="$(sha256_file "$BUNDLE_A/artifacts/post-exit-reference-dark.png")"

printf 'Generating GC sub-demo under %s/gc\n' "$BUNDLE_A"
GC_HOME="$(new_home)"
export AGENT_TERMINAL_HOME="$GC_HOME"
printf '%s\n' "$GC_HOME" > "$BUNDLE_A/gc/agent-terminal-home.txt"
append_command_header "$BUNDLE_A/gc/commands.sh" "$GC_HOME"

run_json_command "$BUNDLE_A/gc/commands.sh" "$BUNDLE_A/gc/create-output.json" create --json -- /bin/sh -lc 'printf "gc-temp\n"; exec cat'
GC_SESSION_ID="$(json_eval "$BUNDLE_A/gc/create-output.json" 'data.result.sessionId')"
printf '%s\n' "$GC_SESSION_ID" > "$BUNDLE_A/gc/session-id.txt"
run_json_command "$BUNDLE_A/gc/commands.sh" "$BUNDLE_A/gc/destroy-output.json" destroy "$GC_SESSION_ID" --json
run_json_command "$BUNDLE_A/gc/commands.sh" "$BUNDLE_A/gc/gc-dry-run.json" gc --dry-run --json
run_json_command "$BUNDLE_A/gc/commands.sh" "$BUNDLE_A/gc/gc.json" gc --json
run_json_command "$BUNDLE_A/gc/commands.sh" "$BUNDLE_A/gc/list-all.json" list --all --json
assert_json_true "$BUNDLE_A/gc/gc-dry-run.json" "data.result.removedSessions.includes('$GC_SESSION_ID')" 'gc dry-run did not include the temporary session'
assert_json_true "$BUNDLE_A/gc/gc.json" "data.result.removedSessions.includes('$GC_SESSION_ID')" 'gc actual run did not remove the temporary session'
assert_json_true "$BUNDLE_A/gc/list-all.json" "!data.result.sessions.some((session) => session.sessionId === '$GC_SESSION_ID')" 'gc list --all still shows the removed session'
GC_REMOVED_COUNT="$(json_eval "$BUNDLE_A/gc/gc.json" 'data.result.removedSessions.length')"
GC_LIST_COUNT="$(json_eval "$BUNDLE_A/gc/list-all.json" 'data.result.sessions.length')"

write_bundle_a_notes "$BUNDLE_A" "$A_SESSION_ID" "$A_HOME" "$LIVE_TEXT_SEQ" "$POST_EXIT_SEQ" "$LIVE_DARK_SHA" "$POST_EXIT_DARK_SHA" "$GC_HOME" "$GC_SESSION_ID" "$GC_REMOVED_COUNT" "$GC_LIST_COUNT"
write_index "$BUNDLE_A"

printf 'Generating %s\n' "$BUNDLE_B"
B_HOME="$(new_home)"
export AGENT_TERMINAL_HOME="$B_HOME"
printf '%s\n' "$B_HOME" > "$BUNDLE_B/agent-terminal-home.txt"
append_command_header "$BUNDLE_B/commands.sh" "$B_HOME"

run_json_command "$BUNDLE_B/commands.sh" "$BUNDLE_B/doctor.json" doctor --json
assert_doctor_ok "$BUNDLE_B/doctor.json"

run_json_command "$BUNDLE_B/commands.sh" "$BUNDLE_B/create-output.json" create --json -- /bin/bash -lc 'echo crash-test-output && exit 42'
B_SESSION_ID="$(json_eval "$BUNDLE_B/create-output.json" 'data.result.sessionId')"
printf '%s\n' "$B_SESSION_ID" > "$BUNDLE_B/session-id.txt"

run_json_command "$BUNDLE_B/commands.sh" "$BUNDLE_B/wait-exit.json" wait "$B_SESSION_ID" --exit --timeout 20000 --json
EXIT_CODE="$(json_eval "$BUNDLE_B/wait-exit.json" 'data.result.exitCode')"
[[ "$EXIT_CODE" == '42' ]] || fail "expected crash exit code 42, got $EXIT_CODE"

run_json_command "$BUNDLE_B/commands.sh" "$BUNDLE_B/inspect-post-crash.json" inspect "$B_SESSION_ID" --json
assert_json_true "$BUNDLE_B/inspect-post-crash.json" "data.result.session.status === 'exited'" 'crash session was not marked exited'
assert_json_true "$BUNDLE_B/inspect-post-crash.json" 'data.result.session.exitCode === 42' 'crash session exit code was not retained'

run_json_command "$BUNDLE_B/commands.sh" "$BUNDLE_B/snapshot-post-crash.json" snapshot "$B_SESSION_ID" --json
B_SNAPSHOT_SEQ="$(json_eval "$BUNDLE_B/snapshot-post-crash.json" 'data.result.capturedAtSeq')"
copy_file "$B_HOME/sessions/$B_SESSION_ID/artifacts/snapshot-$B_SNAPSHOT_SEQ-structured.json" "$BUNDLE_B/artifacts/post-crash-snapshot-structured-artifact.json"
assert_json_true "$BUNDLE_B/snapshot-post-crash.json" "data.result.visibleLines.some((line) => line.text.includes('crash-test-output'))" 'crash snapshot did not include crash-test-output'

run_json_command "$BUNDLE_B/commands.sh" "$BUNDLE_B/screenshot-post-crash.json" screenshot "$B_SESSION_ID" --json
copy_from_json_path "$BUNDLE_B/screenshot-post-crash.json" 'data.result.artifactPath' "$BUNDLE_B/artifacts/post-crash-reference-dark.png"

run_json_command "$BUNDLE_B/commands.sh" "$BUNDLE_B/record-asciicast-post-crash.json" record export "$B_SESSION_ID" --format asciicast --out "$BUNDLE_B/artifacts/session-post-crash.cast" --json
assert_file_exists "$BUNDLE_B/artifacts/session-post-crash.cast"

run_json_command_retry 2 2 "$BUNDLE_B/commands.sh" "$BUNDLE_B/record-webm-post-crash.json" record export "$B_SESSION_ID" --format webm --out "$BUNDLE_B/artifacts/session-post-crash.webm" --json
assert_file_exists "$BUNDLE_B/artifacts/session-post-crash.webm"

copy_file "$B_HOME/sessions/$B_SESSION_ID/artifacts/manifest.json" "$BUNDLE_B/manifest.json"
copy_file "$B_HOME/sessions/$B_SESSION_ID/session.json" "$BUNDLE_B/session-manifest.json"
copy_file "$B_HOME/sessions/$B_SESSION_ID/events.jsonl" "$BUNDLE_B/event-log.jsonl"

write_bundle_b_notes "$BUNDLE_B" "$B_SESSION_ID" "$B_HOME" "$EXIT_CODE"
write_index "$BUNDLE_B"

find "$BUNDLE_A" "$BUNDLE_B" -name '*.json' -type f -print0 | while IFS= read -r -d '' json_file; do
  assert_json_file "$json_file"
done

printf 'Week 3 dogfood bundles generated successfully.\n'
