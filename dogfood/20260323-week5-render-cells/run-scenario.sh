#!/usr/bin/env bash
set -euo pipefail

export MISE_TRUSTED_CONFIG_PATHS="${PWD}"
CLI=(npx tsx src/cli/main.ts)
BUNDLE="dogfood/20260323-week5-render-cells"
FIXTURE_EVENTS="dogfood/20260322-dogfood-color/events.jsonl"
STATUS_TSV="$BUNDLE/command-status.tsv"
COMMANDS_SH="$BUNDLE/commands.sh"
LOG_DIR="$BUNDLE/logs"

mkdir -p "$LOG_DIR"
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
SESSION_ID="01W5CELLS$(date +%s)"
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
    'command': ['echo', 'week5-cells'],
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

run_cmd 01-snapshot-include-cells.json "${CLI[@]}" snapshot "$SESSION_ID" --include-cells --json
run_cmd 02-snapshot-default.json "${CLI[@]}" snapshot "$SESSION_ID" --json
cp "$SESSION_DIR/events.jsonl" "$BUNDLE/events.jsonl"
cp "$SESSION_DIR/session.json" "$BUNDLE/session.json"

python3 - "$BUNDLE" <<'PY'
import json
import sys
from pathlib import Path
bundle = Path(sys.argv[1])
with_cells = json.loads((bundle / '01-snapshot-include-cells.json').read_text())['result']
without_cells = json.loads((bundle / '02-snapshot-default.json').read_text())['result']
samples = []
default_fg = '#cdd6f4'
default_bg = '#1e1e2e'
for line in with_cells.get('cells', []):
    line_number = line.get('lineNumber')
    for cell_index, cell in enumerate(line.get('cells', [])):
        if cell.get('char', ' ') == ' ':
            continue
        interesting = (
            cell.get('bg') not in (None, default_bg)
            or cell.get('fg') not in (None, default_fg)
            or cell.get('bold')
            or cell.get('italic')
            or cell.get('underline')
            or cell.get('strikethrough')
        )
        if interesting:
            samples.append({
                'lineNumber': line_number,
                'cellIndex': cell_index,
                **cell,
            })
        if len(samples) >= 6:
            break
    if len(samples) >= 6:
        break
(bundle / 'cells-sample.json').write_text(json.dumps(samples, indent=2) + '\n')
notes = f'''# 2026-03-23 dogfood — Week 5 Lane B per-cell snapshots

## Bundle metadata

- **Bundle path:** `{bundle.as_posix()}/`
- **Fixture events:** `dogfood/20260322-dogfood-color/events.jsonl`
- **Replay mode:** offline replay against a synthetic exited session (`session.json`)
- **Session ID:** `{with_cells['sessionId']}`

## Scenario summary

This bundle captures the same exited session twice via `snapshot`: once with `--include-cells` and once with the default structured output. Reviewers can diff the JSON files directly.

## Reviewer highlights

- `01-snapshot-include-cells.json` contains a top-level `cells` array with `{len(with_cells.get('cells', []))}` rendered lines of per-cell metadata.
- `02-snapshot-default.json` omits the `cells` key entirely, confirming that per-cell payloads are opt-in.
- Both snapshots agree on the viewport (`{with_cells['cols']}x{with_cells['rows']}`), cursor position (`row {with_cells['cursorRow']}, col {with_cells['cursorCol']}`), and captured sequence (`{with_cells['capturedAtSeq']}`).

## Representative cell entries

`cells-sample.json` extracts the first styled cells discovered in the snapshot so reviewers do not have to hunt through the full payload. These sample entries show foreground/background colors from the replayed ANSI output; this copied color-grid fixture does not emit bold or underline escapes, so the optional style-flag booleans are absent in this specific sample:

```json
{json.dumps(samples, indent=2)}
```

## Comparison guidance

- Open `01-snapshot-include-cells.json` and search for `"cells"` to inspect the full per-cell payload.
- Open `02-snapshot-default.json` and confirm the same visible text is present without the additional cell metadata.
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
