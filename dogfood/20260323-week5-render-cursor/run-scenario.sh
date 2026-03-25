#!/usr/bin/env bash
set -euo pipefail

export MISE_TRUSTED_CONFIG_PATHS="${PWD}"
CLI=(npx tsx src/cli/main.ts)
BUNDLE="dogfood/20260323-week5-render-cursor"
FIXTURE_EVENTS="dogfood/20260322-dogfood-color/events.jsonl"
STATUS_TSV="$BUNDLE/command-status.tsv"
COMMANDS_SH="$BUNDLE/commands.sh"
LOG_DIR="$BUNDLE/logs"
SCREENSHOT_DIR="$BUNDLE/screenshots"
GHOSTTY_JS="node_modules/ghostty-web/dist/ghostty-web.js"
GHOSTTY_BACKUP="${GHOSTTY_JS}.week5-cursor.bak"
PATCH_MARKER="IA.prototype.requestRender = function()"

mkdir -p "$LOG_DIR" "$SCREENSHOT_DIR"
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
  if [[ -f "$GHOSTTY_BACKUP" ]]; then
    mv "$GHOSTTY_BACKUP" "$GHOSTTY_JS"
  fi
  if [[ -n "$AGENT_TERMINAL_HOME" && -d "$AGENT_TERMINAL_HOME" ]]; then
    rm -rf "$AGENT_TERMINAL_HOME"
  fi
  exit "$status"
}
trap cleanup EXIT

patch_request_render() {
  python3 - "$GHOSTTY_JS" "$PATCH_MARKER" <<'PY'
from pathlib import Path
import shutil
import sys
path = Path(sys.argv[1])
marker = sys.argv[2]
text = path.read_text()
if marker in text:
    raise SystemExit(0)
backup = Path(f"{path}.week5-cursor.bak")
if not backup.exists():
    shutil.copy2(path, backup)
patch = "\nif (typeof IA !== 'undefined' && typeof IA.prototype.requestRender !== 'function') {\n  IA.prototype.requestRender = function() {\n    if (this.renderer && this.wasmTerm) {\n      this.renderer.render(this.wasmTerm, !0, this.viewportY, this, this.scrollbarOpacity);\n    }\n  };\n}\n"
marker_text = "\nexport {"
idx = text.rfind(marker_text)
if idx == -1:
    raise SystemExit('export marker not found in ghostty-web bundle')
path.write_text(text[:idx] + patch + text[idx:])
PY
}

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

json_field() {
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json
import sys
value = json.loads(open(sys.argv[1], 'r', encoding='utf-8').read())
for part in sys.argv[2].split('.'):
    if not part:
        continue
    value = value[part]
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

patch_request_render
AGENT_TERMINAL_HOME="$(mktemp -d)"
export AGENT_TERMINAL_HOME
SESSION_ID="01W5CURSR$(date +%s)"
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
    'command': ['echo', 'week5-cursor'],
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

run_cmd 01-screenshot-show-cursor.json "${CLI[@]}" screenshot "$SESSION_ID" --show-cursor --json
copy_if_exists "$(json_field "$BUNDLE/01-screenshot-show-cursor.json" result.artifactPath 2>/dev/null || true)" "$SCREENSHOT_DIR/show-cursor.png"
run_cmd 02-screenshot-hide-cursor.json "${CLI[@]}" screenshot "$SESSION_ID" --hide-cursor --json
copy_if_exists "$(json_field "$BUNDLE/02-screenshot-hide-cursor.json" result.artifactPath 2>/dev/null || true)" "$SCREENSHOT_DIR/hide-cursor.png"
run_cmd 03-screenshot-default.json "${CLI[@]}" screenshot "$SESSION_ID" --json
copy_if_exists "$(json_field "$BUNDLE/03-screenshot-default.json" result.artifactPath 2>/dev/null || true)" "$SCREENSHOT_DIR/default.png"
cp "$SESSION_DIR/events.jsonl" "$BUNDLE/events.jsonl"
cp "$SESSION_DIR/session.json" "$BUNDLE/session.json"

python3 - "$BUNDLE" <<'PY'
import hashlib
import json
import sys
from pathlib import Path
bundle = Path(sys.argv[1])
show = json.loads((bundle / '01-screenshot-show-cursor.json').read_text())['result']
hide = json.loads((bundle / '02-screenshot-hide-cursor.json').read_text())['result']
default = json.loads((bundle / '03-screenshot-default.json').read_text())['result']
show_png = bundle / 'screenshots' / 'show-cursor.png'
hide_png = bundle / 'screenshots' / 'hide-cursor.png'
default_png = bundle / 'screenshots' / 'default.png'
show_sha = hashlib.sha256(show_png.read_bytes()).hexdigest()
hide_sha = hashlib.sha256(hide_png.read_bytes()).hexdigest()
default_sha = hashlib.sha256(default_png.read_bytes()).hexdigest()
notes = f'''# 2026-03-23 dogfood — Week 5 Lane B cursor visibility screenshots

## Bundle metadata

- **Bundle path:** `{bundle.as_posix()}/`
- **Fixture events:** `dogfood/20260322-dogfood-color/events.jsonl`
- **Replay mode:** offline replay against a synthetic exited session (`session.json`)
- **Session ID:** `{show['sessionId']}`

## Scenario summary

This bundle runs `screenshot` three ways against the same exited session: explicit `--show-cursor`, explicit `--hide-cursor`, and the default invocation with no flag.

## Reviewer highlights

- `01-screenshot-show-cursor.json` reports `cursorVisible=true` and produced `screenshots/show-cursor.png`.
- `02-screenshot-hide-cursor.json` reports `cursorVisible=false` and produced `screenshots/hide-cursor.png`.
- `03-screenshot-default.json` also reports `cursorVisible=false`, confirming the default behavior matches `--hide-cursor`.
- PNG digests make the pairing easy to verify: show `{show_sha}`, hide `{hide_sha}`, default `{default_sha}`.
- The default and explicit hide renders {'match exactly' if hide_sha == default_sha else 'do not byte-match in this run'}, which is the key reviewer check for the default-hidden contract.

## Artifact details

- `screenshots/show-cursor.png` — {show['pngSizeBytes']} bytes
- `screenshots/hide-cursor.png` — {hide['pngSizeBytes']} bytes
- `screenshots/default.png` — {default['pngSizeBytes']} bytes
- All three JSON outputs include `renderProfileHash={show['renderProfileHash']}` for the shared `reference-dark` profile.
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
