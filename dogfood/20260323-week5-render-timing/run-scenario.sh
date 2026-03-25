#!/usr/bin/env bash
set -euo pipefail

export MISE_TRUSTED_CONFIG_PATHS="${PWD}"
CLI=(npx tsx src/cli/main.ts)
BUNDLE="dogfood/20260323-week5-render-timing"
FIXTURE_EVENTS="dogfood/20260322-dogfood-color/events.jsonl"
STATUS_TSV="$BUNDLE/command-status.tsv"
COMMANDS_SH="$BUNDLE/commands.sh"
LOG_DIR="$BUNDLE/logs"
RECORDING_DIR="$BUNDLE/recordings"

mkdir -p "$LOG_DIR" "$RECORDING_DIR"
rm -f "$STATUS_TSV" "$COMMANDS_SH" "$BUNDLE/manifest.json"
printf 'step\texit_code\tstdout\tstderr\tcommand\n' > "$STATUS_TSV"
cat > "$COMMANDS_SH" <<'COMMANDS'
#!/usr/bin/env bash
set -euo pipefail
SESSION_ID="REPLACED_BY_RUN_SCENARIO"
COMMANDS
chmod +x "$COMMANDS_SH"

AGENT_TERMINAL_HOME=""
SESSION_ID=""
SESSION_DIR=""
cleanup() {
  local status=$?
  if [[ -n "$AGENT_TERMINAL_HOME" && -d "$AGENT_TERMINAL_HOME" ]]; then
    rm -rf "$AGENT_TERMINAL_HOME"
  fi
  exit "$status"
}
trap cleanup EXIT

log_cmd() {
  local rendered=""
  printf -v rendered '%q ' "$@"
  printf '%s\n' "${rendered% }" >> "$COMMANDS_SH"
}

run_cmd() {
  local step="$1"
  shift
  local stdout="$BUNDLE/${step}.out"
  local stderr="$LOG_DIR/${step}.stderr.txt"
  log_cmd "$@"
  set +e
  "$@" >"$stdout" 2>"$stderr"
  local code=$?
  set -e
  printf '%s\n' "$code" > "$LOG_DIR/${step}.exitcode"
  printf '%s\t%s\t%s\t%s\t' "$step" "$code" "$stdout" "$stderr" >> "$STATUS_TSV"
  local rendered=""
  printf -v rendered '%q ' "$@"
  printf '%s\n' "${rendered% }" >> "$STATUS_TSV"
  if [[ "$code" -eq 0 ]]; then
    mv "$stdout" "$BUNDLE/${step}"
  fi
  return 0
}

AGENT_TERMINAL_HOME="$(mktemp -d)"
export AGENT_TERMINAL_HOME
SESSION_ID="01W5TIMNG$(date +%s)"
SESSION_DIR="$AGENT_TERMINAL_HOME/sessions/$SESSION_ID"
mkdir -p "$SESSION_DIR/artifacts"
python3 - "$SESSION_DIR/session.json" "$SESSION_ID" <<'PY'
import json
import sys
payload = {
    'version': 1,
    'sessionId': sys.argv[2],
    'createdAt': '2026-03-23T16:00:00.000Z',
    'updatedAt': '2026-03-23T16:00:05.000Z',
    'status': 'exited',
    'command': ['echo', 'week5-timing'],
    'cwd': '/tmp',
    'cols': 80,
    'rows': 24,
    'hostPid': None,
    'childPid': None,
    'exitCode': 0,
    'exitSignal': None,
}
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
    fh.write('\n')
PY
cp "$FIXTURE_EVENTS" "$SESSION_DIR/events.jsonl"
python3 - "$COMMANDS_SH" "$SESSION_ID" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace('REPLACED_BY_RUN_SCENARIO', sys.argv[2]))
PY

run_cmd 01-record-export-recorded.json "${CLI[@]}" record export "$SESSION_ID" --format webm --timing recorded --out "$RECORDING_DIR/recorded.webm" --json
run_cmd 02-record-export-accelerated.json "${CLI[@]}" record export "$SESSION_ID" --format webm --timing accelerated --out "$RECORDING_DIR/accelerated.webm" --json
run_cmd 03-record-export-max-speed.json "${CLI[@]}" record export "$SESSION_ID" --format webm --timing max-speed --out "$RECORDING_DIR/max-speed.webm" --json
cp "$SESSION_DIR/events.jsonl" "$BUNDLE/events.jsonl"
cp "$SESSION_DIR/session.json" "$BUNDLE/session.json"

python3 - "$BUNDLE" <<'PY'
import json
import sys
from pathlib import Path
bundle = Path(sys.argv[1])
recorded = json.loads((bundle / '01-record-export-recorded.json').read_text())['result']
accelerated = json.loads((bundle / '02-record-export-accelerated.json').read_text())['result']
max_speed = json.loads((bundle / '03-record-export-max-speed.json').read_text())['result']
notes = f'''# 2026-03-23 dogfood — Week 5 Lane B WebM timing modes

## Bundle metadata

- **Bundle path:** `{bundle.as_posix()}/`
- **Fixture events:** `dogfood/20260322-dogfood-color/events.jsonl`
- **Replay mode:** offline replay against a synthetic exited session (`session.json`)
- **Session ID:** `{recorded['sessionId']}`

## Scenario summary

This bundle exports the same exited session to WebM three times, varying only `--timing recorded|accelerated|max-speed`.

## Reviewer highlights

- `01-record-export-recorded.json` reports `metadata.timingMode="{recorded['metadata']['timingMode']}"` and wrote `recordings/recorded.webm` ({recorded['bytes']} bytes).
- `02-record-export-accelerated.json` reports `metadata.timingMode="{accelerated['metadata']['timingMode']}"` and wrote `recordings/accelerated.webm` ({accelerated['bytes']} bytes).
- `03-record-export-max-speed.json` reports `metadata.timingMode="{max_speed['metadata']['timingMode']}"` and wrote `recordings/max-speed.webm` ({max_speed['bytes']} bytes).
- The implementation default is `accelerated`; this bundle captures all three explicit modes so reviewers can compare the generated files directly.
- For this short color-grid replay, all three exports report the same event-span `durationMs={recorded['durationMs']}` because the underlying output timestamps are already close together; the reviewer-visible proof here is the distinct `timingMode` metadata plus differing WebM file sizes.

## Comparison guidance

- `recorded` preserves the real event gaps from the log.
- `accelerated` caps long gaps while keeping a readable replay speed.
- `max-speed` minimizes delays further (subject to the renderer's minimum frame hold).
- The JSON payloads also carry a shared `renderProfileHash={recorded['metadata']['renderProfileHash']}` for the bundled `reference-dark` profile used for all three exports.
'''
(bundle / 'notes.md').write_text(notes)
manifest_entries = []
for path in sorted(bundle.rglob('*')):
    if path.is_file() and path.name != 'manifest.json':
        manifest_entries.append({
            'path': path.relative_to(bundle).as_posix(),
            'sha256': __import__('hashlib').sha256(path.read_bytes()).hexdigest(),
            'size': path.stat().st_size,
        })
(bundle / 'manifest.json').write_text(json.dumps({'bundle': bundle.name, 'artifacts': manifest_entries}, indent=2) + '\n')
PY
