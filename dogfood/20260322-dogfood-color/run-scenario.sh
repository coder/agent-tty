#!/usr/bin/env bash
set -u
export MISE_TRUSTED_CONFIG_PATHS="$PWD/mise.toml"
export AGENT_TERMINAL_HOME="$(cat dogfood/20260322-dogfood-color/agent-terminal-home.txt)"
CLI=(npx tsx src/cli/main.ts)
BUNDLE="dogfood/20260322-dogfood-color"
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

run_cmd 01-create.json "${CLI[@]}" create --json -- npx tsx test/fixtures/apps/color-grid/main.ts
mv "$BUNDLE/01-create.json.out" "$BUNDLE/01-create.json"
SESSION_ID="$(json_field "$BUNDLE/01-create.json" result.sessionId)"
printf '%s\n' "$SESSION_ID" > "$BUNDLE/session-id.txt"

run_cmd 02-wait-color-grid-complete.json "${CLI[@]}" wait "$SESSION_ID" --text "COLOR GRID COMPLETE" --json
mv "$BUNDLE/02-wait-color-grid-complete.json.out" "$BUNDLE/02-wait-color-grid-complete.json"

run_cmd 03-screenshot-reference-dark.json "${CLI[@]}" screenshot "$SESSION_ID" --profile reference-dark --json
mv "$BUNDLE/03-screenshot-reference-dark.json.out" "$BUNDLE/03-screenshot-reference-dark.json"
copy_if_exists "$(json_field "$BUNDLE/03-screenshot-reference-dark.json" result.artifactPath || true)" "$BUNDLE/screenshots/reference-dark.png"

run_cmd 04-screenshot-reference-light.json "${CLI[@]}" screenshot "$SESSION_ID" --profile reference-light --json
mv "$BUNDLE/04-screenshot-reference-light.json.out" "$BUNDLE/04-screenshot-reference-light.json"
copy_if_exists "$(json_field "$BUNDLE/04-screenshot-reference-light.json" result.artifactPath || true)" "$BUNDLE/screenshots/reference-light.png"

run_cmd 05-snapshot-structured.json "${CLI[@]}" snapshot "$SESSION_ID" --json
mv "$BUNDLE/05-snapshot-structured.json.out" "$BUNDLE/05-snapshot-structured.json"
copy_if_exists "$(json_field "$BUNDLE/05-snapshot-structured.json" result.artifactPath || true)" "$BUNDLE/snapshots/structured.json"

run_cmd 06-snapshot-text.json "${CLI[@]}" snapshot "$SESSION_ID" --format text --json
mv "$BUNDLE/06-snapshot-text.json.out" "$BUNDLE/06-snapshot-text.json"
copy_if_exists "$(json_field "$BUNDLE/06-snapshot-text.json" result.artifactPath || true)" "$BUNDLE/snapshots/text.json"

run_cmd 07-record-export-asciicast.json "${CLI[@]}" record export "$SESSION_ID" --format asciicast --out "$BUNDLE/recordings/color-grid.cast" --json
mv "$BUNDLE/07-record-export-asciicast.json.out" "$BUNDLE/07-record-export-asciicast.json"

run_cmd 08-wait-exit.json "${CLI[@]}" wait "$SESSION_ID" --exit --json
mv "$BUNDLE/08-wait-exit.json.out" "$BUNDLE/08-wait-exit.json"

run_cmd 09-inspect.json "${CLI[@]}" inspect "$SESSION_ID" --json
mv "$BUNDLE/09-inspect.json.out" "$BUNDLE/09-inspect.json"

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
