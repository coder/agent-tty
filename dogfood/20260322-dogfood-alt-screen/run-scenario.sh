#!/usr/bin/env bash
set -u
export MISE_TRUSTED_CONFIG_PATHS="$PWD/mise.toml"
export AGENT_TERMINAL_HOME="$(cat dogfood/20260322-dogfood-alt-screen/agent-terminal-home.txt)"
CLI=(npx tsx src/cli/main.ts)
BUNDLE="dogfood/20260322-dogfood-alt-screen"
STATUS_TSV="$BUNDLE/command-status.tsv"
COMMANDS_SH="$BUNDLE/commands.sh"
: > "$COMMANDS_SH"
chmod +x "$COMMANDS_SH"
printf 'step\texit_code\tstdout\tstderr\tcommand\n' > "$STATUS_TSV"

log_cmd() {
  local rendered=""
  printf -v rendered '%q ' "$@"
  printf '%s\n' "${rendered% }" >> "$COMMANDS_SH"
}

run_cmd() {
  local step="$1"; shift
  local stdout="$BUNDLE/${step}.out"
  local stderr="$BUNDLE/logs/${step}.stderr.txt"
  log_cmd "$@"
  "$@" >"$stdout" 2>"$stderr"
  local code=$?
  printf '%s\t%s\t%s\t%s\t' "$step" "$code" "$stdout" "$stderr" >> "$STATUS_TSV"
  local rendered=""
  printf -v rendered '%q ' "$@"
  printf '%s\n' "${rendered% }" >> "$STATUS_TSV"
  printf '%s\n' "$code" > "$BUNDLE/logs/${step}.exitcode"
  return 0
}

json_field() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1:3]
with open(path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)
value = data
for part in expr.split('.'):
    if not part:
        continue
    if isinstance(value, dict) and part in value:
        value = value[part]
    else:
        raise SystemExit(1)
if isinstance(value, (dict, list)):
    print(json.dumps(value))
else:
    print(value)
PY
}

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [[ -n "$src" && -f "$src" ]]; then
    cp "$src" "$dest"
  fi
}

run_cmd 01-create.json "${CLI[@]}" create --json -- npx tsx test/fixtures/apps/alt-screen-demo/main.ts
mv "$BUNDLE/01-create.json.out" "$BUNDLE/01-create.json"
SESSION_ID="$(json_field "$BUNDLE/01-create.json" result.sessionId)"
printf '%s\n' "$SESSION_ID" > "$BUNDLE/session-id.txt"

run_cmd 02-wait-main-screen-ready.json "${CLI[@]}" wait "$SESSION_ID" --text "MAIN SCREEN READY" --json
mv "$BUNDLE/02-wait-main-screen-ready.json.out" "$BUNDLE/02-wait-main-screen-ready.json"

run_cmd 03-snapshot-primary-before.json "${CLI[@]}" snapshot "$SESSION_ID" --json
mv "$BUNDLE/03-snapshot-primary-before.json.out" "$BUNDLE/03-snapshot-primary-before.json"

run_cmd 04-screenshot-primary-before.json "${CLI[@]}" screenshot "$SESSION_ID" --json
mv "$BUNDLE/04-screenshot-primary-before.json.out" "$BUNDLE/04-screenshot-primary-before.json"
copy_if_exists "$(json_field "$BUNDLE/04-screenshot-primary-before.json" result.artifactPath || true)" "$BUNDLE/screenshots/primary-before.png"

run_cmd 05-send-keys-enter-alt-screen.txt "${CLI[@]}" send-keys "$SESSION_ID" Enter
mv "$BUNDLE/05-send-keys-enter-alt-screen.txt.out" "$BUNDLE/05-send-keys-enter-alt-screen.txt"

run_cmd 06-wait-alt-screen-active.json "${CLI[@]}" wait "$SESSION_ID" --text "ALT SCREEN ACTIVE" --json
mv "$BUNDLE/06-wait-alt-screen-active.json.out" "$BUNDLE/06-wait-alt-screen-active.json"

run_cmd 07-snapshot-alt-screen.json "${CLI[@]}" snapshot "$SESSION_ID" --json
mv "$BUNDLE/07-snapshot-alt-screen.json.out" "$BUNDLE/07-snapshot-alt-screen.json"

run_cmd 08-screenshot-alternate.json "${CLI[@]}" screenshot "$SESSION_ID" --json
mv "$BUNDLE/08-screenshot-alternate.json.out" "$BUNDLE/08-screenshot-alternate.json"
copy_if_exists "$(json_field "$BUNDLE/08-screenshot-alternate.json" result.artifactPath || true)" "$BUNDLE/screenshots/alternate.png"

run_cmd 09-send-keys-enter-exit-alt-screen.txt "${CLI[@]}" send-keys "$SESSION_ID" Enter
mv "$BUNDLE/09-send-keys-enter-exit-alt-screen.txt.out" "$BUNDLE/09-send-keys-enter-exit-alt-screen.txt"

run_cmd 10-wait-back-on-main-screen.json "${CLI[@]}" wait "$SESSION_ID" --text "BACK ON MAIN SCREEN" --json
mv "$BUNDLE/10-wait-back-on-main-screen.json.out" "$BUNDLE/10-wait-back-on-main-screen.json"

run_cmd 11-snapshot-primary-after.json "${CLI[@]}" snapshot "$SESSION_ID" --json
mv "$BUNDLE/11-snapshot-primary-after.json.out" "$BUNDLE/11-snapshot-primary-after.json"

run_cmd 12-screenshot-primary-after.json "${CLI[@]}" screenshot "$SESSION_ID" --json
mv "$BUNDLE/12-screenshot-primary-after.json.out" "$BUNDLE/12-screenshot-primary-after.json"
copy_if_exists "$(json_field "$BUNDLE/12-screenshot-primary-after.json" result.artifactPath || true)" "$BUNDLE/screenshots/primary-after.png"

run_cmd 13-record-export-webm.json "${CLI[@]}" record export "$SESSION_ID" --format webm --out "$BUNDLE/videos/alt-screen.webm" --json
mv "$BUNDLE/13-record-export-webm.json.out" "$BUNDLE/13-record-export-webm.json"

run_cmd 14-record-export-asciicast.json "${CLI[@]}" record export "$SESSION_ID" --format asciicast --out "$BUNDLE/recordings/alt-screen.cast" --json
mv "$BUNDLE/14-record-export-asciicast.json.out" "$BUNDLE/14-record-export-asciicast.json"

run_cmd 15-wait-exit.json "${CLI[@]}" wait "$SESSION_ID" --exit --json
mv "$BUNDLE/15-wait-exit.json.out" "$BUNDLE/15-wait-exit.json"

run_cmd 16-inspect.json "${CLI[@]}" inspect "$SESSION_ID" --json
mv "$BUNDLE/16-inspect.json.out" "$BUNDLE/16-inspect.json"

SESSION_DIR="$AGENT_TERMINAL_HOME/sessions/$SESSION_ID"
copy_if_exists "$SESSION_DIR/events.jsonl" "$BUNDLE/events.jsonl"
copy_if_exists "$SESSION_DIR/manifest.json" "$BUNDLE/session-manifest.json"

python3 - "$BUNDLE" <<'PY'
import json, os, hashlib, sys
bundle = sys.argv[1]
artifacts = []
for root, _, files in os.walk(bundle):
    for name in sorted(files):
        path = os.path.join(root, name)
        rel = os.path.relpath(path, bundle)
        with open(path, 'rb') as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        artifacts.append({"path": rel, "sha256": sha, "size": os.path.getsize(path)})
with open(os.path.join(bundle, 'manifest.json'), 'w', encoding='utf-8') as fh:
    json.dump({"bundle": os.path.basename(bundle), "artifacts": artifacts}, fh, indent=2)
    fh.write('\n')
PY
