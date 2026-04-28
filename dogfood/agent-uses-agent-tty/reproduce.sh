#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BUNDLE_DIR="$SCRIPT_DIR"
ARTIFACTS_DIR="$BUNDLE_DIR/artifacts"
PROMPTS_DIR="$BUNDLE_DIR/prompts"
REQUESTED_AGENT="both"
DEMO_SENTENCE="agent-tty nested Neovim proof from an AI coding agent."
OUTER_TIMEOUT_MS="${AGENT_USES_AGENT_TTY_TIMEOUT_MS:-1200000}"
PROOF_TIMEOUT_MS="${AGENT_USES_AGENT_TTY_PROOF_TIMEOUT_MS:-900000}"
WEBM_TIMING="${AGENT_USES_AGENT_TTY_WEBM_TIMING:-recorded}"
CODEX_MODEL="${AGENT_USES_AGENT_TTY_CODEX_MODEL:-gpt-5.4-mini}"
REVIEW_TAIL_SECONDS="${AGENT_USES_AGENT_TTY_REVIEW_TAIL_SECONDS:-6}"
REVIEW_SLOWDOWN="${AGENT_USES_AGENT_TTY_REVIEW_SLOWDOWN:-4}"
REVIEW_CPU_USED="${AGENT_USES_AGENT_TTY_REVIEW_CPU_USED:-4}"
REVIEW_CRF="${AGENT_USES_AGENT_TTY_REVIEW_CRF:-34}"
KEEP_TEMP="${KEEP_AGENT_USES_AGENT_TTY_TEMP:-0}"
TEMP_ROOT=""
INSTALL_PREFIX=""
PACK_TARBALL_PATH=""
CURRENT_OUTER_HOME=""
CURRENT_OUTER_SESSION_ID=""

usage() {
  cat <<'EOF'
Usage: bash dogfood/agent-uses-agent-tty/reproduce.sh [--agent codex|claude|both]

Builds and temp-installs the local agent-tty package, then records Codex and/or
Claude using public `agent-tty ...` commands to drive a clean Neovim session.
EOF
}

log() {
  printf '[agent-uses-agent-tty] %s\n' "$*"
}

fail() {
  printf '[agent-uses-agent-tty] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

assert_file_nonempty() {
  local path="$1"
  [[ -s "$path" ]] || fail "expected non-empty file: $path"
}

assert_positive_number() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "$name must be numeric"
  node -e 'process.exit(Number(process.argv[1]) > 0 ? 0 : 1)' "$value" || fail "$name must be greater than 0"
}

assert_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be an integer"
  (( value > 0 )) || fail "$name must be greater than 0"
}

assert_integer_at_least() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  assert_positive_integer "$name" "$value"
  (( value >= minimum )) || fail "$name must be at least $minimum"
}

file_state() {
  local path="$1"
  if [[ -s "$path" ]]; then
    printf 'present:%sB' "$(wc -c < "$path" | tr -d ' ')"
  elif [[ -e "$path" ]]; then
    printf 'empty'
  else
    printf 'missing'
  fi
}

assert_text_file_equals() {
  local path="$1"
  local expected="$2"
  assert_file_nonempty "$path"
  local actual
  actual="$(cat "$path")"
  [[ "$actual" == "$expected" ]] || {
    printf 'expected: %s\nactual:   %s\n' "$expected" "$actual" >&2
    fail "unexpected file content: $path"
  }
}

run_json_file() {
  local output_path="$1"
  shift
  [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]] || fail 'TEMP_ROOT must exist before run_json_file'
  local tmp_path
  tmp_path="$(mktemp "$TEMP_ROOT/run-json.XXXXXX")"
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
  raw_json="$("$@")"
  pretty_json="$(printf '%s\n' "$raw_json" | jq .)"
  printf '%s\n' "$pretty_json" | jq -e '.ok == true' >/dev/null
  printf -v "$__resultvar" '%s' "$pretty_json"
}

copy_artifact_from_envelope() {
  local envelope_path="$1"
  local destination_path="$2"
  local source_path
  source_path="$(jq -er '.result.artifactPath' "$envelope_path")"
  assert_file_nonempty "$source_path"
  cp "$source_path" "$destination_path"
  assert_file_nonempty "$destination_path"
}

media_duration_seconds() {
  local path="$1"
  ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$path"
}

assert_media_duration_at_least() {
  local path="$1"
  local min_seconds="$2"
  local label="$3"
  local duration

  duration="$(media_duration_seconds "$path")"
  node -e 'const duration = Number(process.argv[1]); const min = Number(process.argv[2]); process.exit(Number.isFinite(duration) && duration >= min ? 0 : 1);' "$duration" "$min_seconds" ||
    fail "$label duration is ${duration}s (minimum ${min_seconds}s): $path"
}

slow_outer_webm_for_review() {
  local source_webm="$1"
  local destination_webm="$2"
  local duration
  local trim_start

  duration="$(media_duration_seconds "$source_webm")"
  trim_start="$(node -e 'const duration = Number(process.argv[1]); const tail = Number(process.argv[2]); console.log(Math.max(0, duration - tail).toFixed(3));' "$duration" "$REVIEW_TAIL_SECONDS")"

  # VP9 CRF 34 and cpu-used 4 keep checked-in review cuts compact while
  # preserving enough terminal text detail for GitHub reviewers.
  ffmpeg -nostdin -y -hide_banner -loglevel error -i "$source_webm" -vf "trim=start=$trim_start,setpts=$REVIEW_SLOWDOWN*(PTS-STARTPTS)" -an -c:v libvpx-vp9 -deadline good -cpu-used "$REVIEW_CPU_USED" -b:v 0 -crf "$REVIEW_CRF" "$destination_webm"
  assert_file_nonempty "$destination_webm"
  assert_media_duration_at_least "$destination_webm" 5 'outer review WebM'
}

destroy_sessions_in_home() {
  local home="$1"
  local list_json

  [[ -d "$home" ]] || return 0
  command -v agent-tty >/dev/null 2>&1 || return 0
  list_json="$(agent-tty --home "$home" list --all --json 2>/dev/null)" || return 0
  while IFS= read -r session_id; do
    [[ -n "$session_id" ]] || continue
    agent-tty --home "$home" destroy "$session_id" --force --json >/dev/null 2>&1 || true
  done < <(printf '%s\n' "$list_json" | jq -r '.result.sessions[].sessionId?')
}

try_capture_outer_thumbnail() {
  local outer_home="$1"
  local session_id="$2"
  local envelope_path="$3"
  local thumbnail_path="$4"
  local tmp_path

  [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]] || fail 'TEMP_ROOT must exist before try_capture_outer_thumbnail'
  tmp_path="$(mktemp "$TEMP_ROOT/outer-screenshot.XXXXXX")"
  if agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" screenshot "$session_id" --hide-cursor --json > "$tmp_path"; then
    if jq . "$tmp_path" > "$envelope_path"; then
      rm -f "$tmp_path"
      if jq -e '.ok == true' "$envelope_path" >/dev/null; then
        copy_artifact_from_envelope "$envelope_path" "$thumbnail_path"
        return 0
      fi
      return 1
    fi
  fi

  if [[ -s "$tmp_path" ]]; then
    jq . "$tmp_path" > "$envelope_path" 2>/dev/null || cp "$tmp_path" "$envelope_path"
  fi
  rm -f "$tmp_path"
  return 1
}

cleanup() {
  local exit_code=$?
  set +e
  if [[ -n "$CURRENT_OUTER_HOME" && -n "$CURRENT_OUTER_SESSION_ID" ]]; then
    agent-tty --home "$CURRENT_OUTER_HOME" destroy "$CURRENT_OUTER_SESSION_ID" --force --json >/dev/null 2>&1 || true
  fi
  if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]]; then
    local home
    for home in "$TEMP_ROOT"/inner-home/* "$TEMP_ROOT"/outer-home/*; do
      destroy_sessions_in_home "$home"
    done
  fi
  if [[ -n "$PACK_TARBALL_PATH" && -f "$PACK_TARBALL_PATH" ]]; then
    rm -f "$PACK_TARBALL_PATH"
  fi
  if [[ "$KEEP_TEMP" == "1" && -n "$TEMP_ROOT" ]]; then
    printf '[agent-uses-agent-tty] kept temp root: %s\n' "$TEMP_ROOT" >&2
  elif [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]]; then
    rm -rf "$TEMP_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent)
        [[ $# -ge 2 ]] || fail '--agent requires a value'
        REQUESTED_AGENT="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "unknown argument: $1"
        ;;
    esac
  done

  case "$REQUESTED_AGENT" in
    codex|claude|both) ;;
    *) fail "--agent must be one of: codex, claude, both" ;;
  esac

  case "$WEBM_TIMING" in
    recorded|accelerated|max-speed) ;;
    *) fail "AGENT_USES_AGENT_TTY_WEBM_TIMING must be one of: recorded, accelerated, max-speed" ;;
  esac
  assert_integer_at_least 'AGENT_USES_AGENT_TTY_TIMEOUT_MS' "$OUTER_TIMEOUT_MS" 1000
  assert_integer_at_least 'AGENT_USES_AGENT_TTY_PROOF_TIMEOUT_MS' "$PROOF_TIMEOUT_MS" 1000
  assert_positive_number 'AGENT_USES_AGENT_TTY_REVIEW_TAIL_SECONDS' "$REVIEW_TAIL_SECONDS"
  assert_positive_number 'AGENT_USES_AGENT_TTY_REVIEW_SLOWDOWN' "$REVIEW_SLOWDOWN"
  assert_positive_integer 'AGENT_USES_AGENT_TTY_REVIEW_CPU_USED' "$REVIEW_CPU_USED"
  assert_positive_integer 'AGENT_USES_AGENT_TTY_REVIEW_CRF' "$REVIEW_CRF"
}

selected_agents() {
  case "$REQUESTED_AGENT" in
    codex) printf '%s\n' codex ;;
    claude) printf '%s\n' claude ;;
    both)
      printf '%s\n' codex
      printf '%s\n' claude
      ;;
  esac
}

render_prompt() {
  local prompt_path="$1"
  local workspace="$2"
  local inner_home="$3"
  local final_file="$4"
  local inner_cast="$5"
  local inner_webm="$6"
  local inner_helper="$7"
  local xdg_config_home="$8"
  local xdg_data_home="$9"
  local xdg_state_home="${10}"
  local xdg_cache_home="${11}"
  local template_path="$PROMPTS_DIR/template.md"
  [[ -f "$template_path" ]] || fail "missing prompt template: $template_path"

  local prompt
  prompt="$(cat "$template_path")"
  prompt="${prompt//\{\{DEMO_SENTENCE\}\}/$DEMO_SENTENCE}"
  prompt="${prompt//\{\{WORKSPACE\}\}/$workspace}"
  prompt="${prompt//\{\{AGENT_TTY_BIN_DIR\}\}/$INSTALL_PREFIX\/bin}"
  prompt="${prompt//\{\{INNER_HELPER\}\}/$inner_helper}"
  prompt="${prompt//\{\{INNER_HOME\}\}/$inner_home}"
  prompt="${prompt//\{\{FINAL_FILE\}\}/$final_file}"
  prompt="${prompt//\{\{INNER_CAST\}\}/$inner_cast}"
  prompt="${prompt//\{\{INNER_WEBM\}\}/$inner_webm}"
  prompt="${prompt//\{\{XDG_CONFIG_HOME\}\}/$xdg_config_home}"
  prompt="${prompt//\{\{XDG_DATA_HOME\}\}/$xdg_data_home}"
  prompt="${prompt//\{\{XDG_STATE_HOME\}\}/$xdg_state_home}"
  prompt="${prompt//\{\{XDG_CACHE_HOME\}\}/$xdg_cache_home}"
  printf '%s\n' "$prompt" > "$prompt_path"
  if grep -q '{{' "$prompt_path"; then
    fail "unsubstituted placeholders in rendered prompt: $prompt_path"
  fi
}

write_inner_helper() {
  local helper_path="$1"
  local workspace="$2"
  local inner_home="$3"
  local final_file="$4"
  local inner_cast="$5"
  local inner_webm="$6"
  local xdg_config_home="$7"
  local xdg_data_home="$8"
  local xdg_state_home="$9"
  local xdg_cache_home="${10}"

  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'export PATH=%q/bin:$PATH\n' "$INSTALL_PREFIX"
    printf 'hash -r\n'
    printf 'test "$(command -v agent-tty)" = %q/bin/agent-tty\n' "$INSTALL_PREFIX"
    printf 'EXPECTED=%q\n' "$DEMO_SENTENCE"
    printf 'WORKSPACE=%q\n' "$workspace"
    printf 'INNER_HOME=%q\n' "$inner_home"
    printf 'FINAL_FILE=%q\n' "$final_file"
    printf 'INNER_CAST=%q\n' "$inner_cast"
    printf 'INNER_WEBM=%q\n' "$inner_webm"
    printf 'XDG_CONFIG_HOME=%q\n' "$xdg_config_home"
    printf 'XDG_DATA_HOME=%q\n' "$xdg_data_home"
    printf 'XDG_STATE_HOME=%q\n' "$xdg_state_home"
    printf 'XDG_CACHE_HOME=%q\n' "$xdg_cache_home"
    printf 'DIAGNOSTICS_DIR="$WORKSPACE/diagnostics"\n'
    printf 'SESSION_ID=\n'
    printf 'cleanup() {\n'
    printf '  if [[ -n "${SESSION_ID:-}" ]]; then\n'
    printf '    agent-tty --home "$INNER_HOME" destroy "$SESSION_ID" --json >/dev/null 2>&1 || true\n'
    printf '  fi\n'
    printf '}\n'
    printf 'trap cleanup EXIT\n'
    printf 'mkdir -p "$INNER_HOME" "$(dirname "$INNER_CAST")" "$DIAGNOSTICS_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"\n'
    printf 'export PS4="$ "\n'
    printf 'set -x\n'
    printf 'agent-tty skills get agent-tty >"$DIAGNOSTICS_DIR/agent-tty-skill.md"\n'
    printf 'agent-tty --home "$INNER_HOME" doctor --json >"$DIAGNOSTICS_DIR/agent-tty-inner-doctor.json"\n'
    printf 'SESSION_ID="$(agent-tty --home "$INNER_HOME" create --json --cwd "$WORKSPACE" --cols 100 --rows 28 --name inner-nvim --shell /bin/bash | jq -r '"'"'.result.sessionId'"'"')"\n'
    printf 'agent-tty --home "$INNER_HOME" run "$SESSION_ID" "printf '"'"'launching nvim --clean -n demo-note.txt\\\\n'"'"'; XDG_CONFIG_HOME=\\"$XDG_CONFIG_HOME\\" XDG_DATA_HOME=\\"$XDG_DATA_HOME\\" XDG_STATE_HOME=\\"$XDG_STATE_HOME\\" XDG_CACHE_HOME=\\"$XDG_CACHE_HOME\\" nvim --clean -n demo-note.txt" --no-wait --json\n'
    printf 'agent-tty --home "$INNER_HOME" wait "$SESSION_ID" --screen-stable-ms 1000 --timeout 60000 --json\n'
    printf 'agent-tty --home "$INNER_HOME" type "$SESSION_ID" i --json\n'
    printf 'agent-tty --home "$INNER_HOME" paste "$SESSION_ID" "$EXPECTED" --json\n'
    printf 'agent-tty --home "$INNER_HOME" wait "$SESSION_ID" --text "$EXPECTED" --timeout 60000 --json\n'
    printf 'agent-tty --home "$INNER_HOME" send-keys "$SESSION_ID" Escape --json\n'
    printf 'agent-tty --home "$INNER_HOME" type "$SESSION_ID" :wq --json\n'
    printf 'agent-tty --home "$INNER_HOME" send-keys "$SESSION_ID" Enter --json\n'
    printf 'agent-tty --home "$INNER_HOME" wait "$SESSION_ID" --screen-stable-ms 1000 --timeout 60000 --json\n'
    printf 'test "$(cat "$FINAL_FILE")" = "$EXPECTED"\n'
    printf 'agent-tty --home "$INNER_HOME" record export "$SESSION_ID" --format asciicast --out "$INNER_CAST" --json\n'
    printf 'agent-tty --home "$INNER_HOME" record export "$SESSION_ID" --format webm --timing %q --out "$INNER_WEBM" --json\n' "$WEBM_TIMING"
    printf 'agent-tty --home "$INNER_HOME" destroy "$SESSION_ID" --json\n'
    printf 'SESSION_ID=\n'
    printf 'set +x\n'
    printf 'trap - EXIT\n'
    printf 'printf "final_file=%%s\\ninner_cast=%%s\\ninner_webm=%%s\\n" "$FINAL_FILE" "$INNER_CAST" "$INNER_WEBM"\n'
  } > "$helper_path"
  chmod +x "$helper_path"
}

write_runner() {
  local agent="$1"
  local runner_path="$2"
  local workspace="$3"
  local prompt_path="$4"
  local real_workspace
  real_workspace="$(cd "$workspace" && pwd -P)"

  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'cd %q\n' "$real_workspace"
    printf 'PROMPT_PATH=%q\n' "$prompt_path"
    printf 'PROMPT="$(cat "$PROMPT_PATH")"\n'
    if [[ "$agent" == 'codex' ]]; then
      local codex_trust_config
      codex_trust_config="projects.\"$real_workspace\".trust_level=\"trusted\""
      printf 'CODEX_TRUST_CONFIG=%q\n' "$codex_trust_config"
      printf 'printf '"'"'%%s\\n'"'"' %q\n' '$ codex --cd "$PWD" --model '"$CODEX_MODEL"' -c "$CODEX_TRUST_CONFIG" -c model_reasoning_effort=\"low\" --dangerously-bypass-approvals-and-sandbox "$PROMPT"'
      printf 'codex --cd "$PWD" --model %q -c "$CODEX_TRUST_CONFIG" -c model_reasoning_effort=\\"low\\" --dangerously-bypass-approvals-and-sandbox "$PROMPT"\n' "$CODEX_MODEL"
    elif [[ "$agent" == 'claude' ]]; then
      printf 'printf '"'"'%%s\\n'"'"' %q\n' '$ claude --permission-mode bypassPermissions --dangerously-skip-permissions --effort low "$PROMPT"'
      printf 'claude --permission-mode bypassPermissions --dangerously-skip-permissions --effort low "$PROMPT"\n'
    else
      fail "unsupported runner agent: $agent"
    fi
  } > "$runner_path"
  chmod +x "$runner_path"
}

wait_for_agent_proof() {
  local outer_home="$1"
  local session_id="$2"
  local final_file="$3"
  local inner_cast="$4"
  local inner_webm="$5"
  local deadline=$((SECONDS + (PROOF_TIMEOUT_MS / 1000)))

  while (( SECONDS < deadline )); do
    if [[ -s "$final_file" && -s "$inner_cast" && -s "$inner_webm" ]]; then
      return 0
    fi

    local wait_json
    wait_json="$(agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" wait "$session_id" --exit --timeout 1000 --json 2>/dev/null || true)"
    if [[ -z "$wait_json" ]]; then
      fail "outer agent liveness check returned no JSON before nested proof files were ready: session_id=$session_id, final_file=$(file_state "$final_file"), inner_cast=$(file_state "$inner_cast"), inner_webm=$(file_state "$inner_webm")"
    fi
    if ! printf '%s\n' "$wait_json" | jq . >/dev/null 2>&1; then
      fail "outer agent liveness check returned invalid JSON before nested proof files were ready: session_id=$session_id, final_file=$(file_state "$final_file"), inner_cast=$(file_state "$inner_cast"), inner_webm=$(file_state "$inner_webm")"
    fi
    if ! printf '%s\n' "$wait_json" | jq -e '.ok == true' >/dev/null; then
      local error_message
      error_message="$(printf '%s\n' "$wait_json" | jq -r '.error.message // .error // "unknown"')"
      fail "outer agent liveness check failed before nested proof files were ready: session_id=$session_id, error=$error_message, final_file=$(file_state "$final_file"), inner_cast=$(file_state "$inner_cast"), inner_webm=$(file_state "$inner_webm")"
    fi
    if printf '%s\n' "$wait_json" | jq -e '.result.timedOut == false' >/dev/null; then
      local exit_code
      exit_code="$(printf '%s\n' "$wait_json" | jq -r '.result.exitCode // "unknown"')"
      fail "outer agent exited before nested proof files were ready: exit_code=$exit_code, final_file=$(file_state "$final_file"), inner_cast=$(file_state "$inner_cast"), inner_webm=$(file_state "$inner_webm")"
    fi
    sleep 1
  done

  fail "timed out waiting for nested agent proof files: final_file=$(file_state "$final_file"), inner_cast=$(file_state "$inner_cast"), inner_webm=$(file_state "$inner_webm")"
}

stop_outer_agent_tui() {
  local agent="$1"
  local outer_home="$2"
  local session_id="$3"
  local wait_path="$4"

  try_wait_for_outer_exit() {
    local tmp_path
    [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]] || fail 'TEMP_ROOT must exist before try_wait_for_outer_exit'
    tmp_path="$(mktemp "$TEMP_ROOT/outer-wait-exit.XXXXXX")"
    if agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" wait "$session_id" --exit --timeout 20000 --json > "$tmp_path"; then
      if jq . "$tmp_path" > "$wait_path"; then
        rm -f "$tmp_path"
        if jq -e '.ok == true and .result.timedOut == false' "$wait_path" >/dev/null; then
          return 0
        fi
        return 1
      fi
    fi
    if [[ -s "$tmp_path" ]]; then
      jq . "$tmp_path" > "$wait_path" 2>/dev/null || cp "$tmp_path" "$wait_path"
    fi
    rm -f "$tmp_path"
    return 1
  }

  case "$agent" in
    codex)
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" send-keys "$session_id" Ctrl+C --json >/dev/null || true
      sleep 1
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" type "$session_id" '/quit' --json >/dev/null || true
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" send-keys "$session_id" Enter --json >/dev/null || true
      try_wait_for_outer_exit && return 0
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" type "$session_id" '/exit' --json >/dev/null || true
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" send-keys "$session_id" Enter --json >/dev/null || true
      try_wait_for_outer_exit && return 0
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" send-keys "$session_id" Ctrl+C Ctrl+C --json >/dev/null || true
      try_wait_for_outer_exit && return 0
      ;;
    claude)
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" type "$session_id" '/exit' --json >/dev/null || true
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" send-keys "$session_id" Enter --json >/dev/null || true
      try_wait_for_outer_exit && return 0
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" send-keys "$session_id" Ctrl+C Ctrl+C --json >/dev/null || true
      try_wait_for_outer_exit && return 0
      ;;
    *)
      fail "unsupported outer agent: $agent"
      ;;
  esac

  fail "timed out waiting for $agent TUI to exit"
}

acknowledge_startup_prompt_if_present() {
  local outer_home="$1"
  local session_id="$2"
  local tmp_path="$3"

  if agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" wait "$session_id" --regex 'Do you trust|trust this|trust this folder|Yes.*trust|Accessing workspace|continue.*trust|Press.*continue' --timeout 30000 --json > "$tmp_path" 2>/dev/null; then
    if jq -e '.ok == true and .result.matched == true' "$tmp_path" >/dev/null; then
      agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" send-keys "$session_id" Enter --json >/dev/null || true
    fi
  fi
  rm -f "$tmp_path"
}

install_local_agent_tty() {
  log 'building local package'
  (cd "$REPO_ROOT" && npm run build)

  log 'packing and temp-installing agent-tty'
  local pack_json="$TEMP_ROOT/npm-pack.json"
  (cd "$REPO_ROOT" && npm pack --json --ignore-scripts) > "$pack_json"
  local tarball_name
  tarball_name="$(jq -er '.[0].filename' "$pack_json")"
  PACK_TARBALL_PATH="$REPO_ROOT/$tarball_name"
  assert_file_nonempty "$PACK_TARBALL_PATH"
  npm install -g --prefix "$INSTALL_PREFIX" "$PACK_TARBALL_PATH" >/dev/null
  rm -f "$PACK_TARBALL_PATH"
  PACK_TARBALL_PATH=""

  export PATH="$INSTALL_PREFIX/bin:$PATH"
  require_command agent-tty
}

write_environment_file() {
  local env_path="$BUNDLE_DIR/environment.txt"
  local doctor_home="$TEMP_ROOT/doctor-home"
  {
    printf '$ git rev-parse HEAD\n%s\n\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"
    printf '$ git log --oneline -n 1\n%s\n\n' "$(git -C "$REPO_ROOT" log --oneline -n 1)"
    printf '$ node --version\n%s\n\n' "$(node --version)"
    printf '$ npm --version\n%s\n\n' "$(npm --version)"
    printf '$ nvim --version | sed -n "1p"\n%s\n\n' "$(nvim --version | sed -n '1p')"
    printf '$ agent-tty version --json\n'
    agent-tty version --json | jq .
    printf '\n$ agent-tty --home <temp> doctor --json\n'
    agent-tty --home "$doctor_home" doctor --json | jq .
    if command -v codex >/dev/null 2>&1; then
      printf '\n$ codex --version\n%s\n' "$(codex --version)"
      if codex login status >/dev/null 2>&1; then
        printf '$ codex login status\nok\n'
      else
        printf '$ codex login status\nfailed\n'
      fi
    fi
    if command -v claude >/dev/null 2>&1; then
      printf '\n$ claude --version\n%s\n' "$(claude --version)"
      if claude auth status >/dev/null 2>&1; then
        printf '$ claude auth status\nok\n'
      else
        printf '$ claude auth status\nfailed\n'
      fi
    fi
  } > "$env_path"
}

clean_agent_outputs() {
  local agent="$1"
  rm -f "$BUNDLE_DIR/$agent-"*.json
  rm -f "$ARTIFACTS_DIR/$agent-"*
}

verify_agent_outputs() {
  local agent="$1"
  local workspace="$2"
  local final_file="$3"
  local inner_cast="$4"
  local inner_webm="$5"
  local proof_path="$ARTIFACTS_DIR/$agent-final-file-proof.txt"

  assert_text_file_equals "$final_file" "$DEMO_SENTENCE"
  assert_file_nonempty "$inner_cast"
  assert_file_nonempty "$inner_webm"
  grep -F 'nvim --clean -n demo-note.txt' "$inner_cast" >/dev/null || fail "inner cast does not show the clean Neovim launch: $inner_cast"
  grep -F "$DEMO_SENTENCE" "$inner_cast" >/dev/null || fail "inner cast does not contain the expected sentence: $inner_cast"
  assert_media_duration_at_least "$inner_webm" 1 'inner WebM'

  cp "$final_file" "$ARTIFACTS_DIR/$agent-demo-note.txt"
  cp "$inner_cast" "$ARTIFACTS_DIR/$agent-inner-nvim.cast"
  cp "$inner_webm" "$ARTIFACTS_DIR/$agent-inner-nvim.webm"
  assert_file_nonempty "$ARTIFACTS_DIR/$agent-demo-note.txt"
  assert_file_nonempty "$ARTIFACTS_DIR/$agent-inner-nvim.cast"
  assert_file_nonempty "$ARTIFACTS_DIR/$agent-inner-nvim.webm"

  {
    printf 'agent=%s\n' "$agent"
    printf 'workspace=%s\n' "$workspace"
    printf 'file=%s\n' "$final_file"
    printf 'expected=%s\n' "$DEMO_SENTENCE"
    printf 'actual=%s\n' "$(cat "$final_file")"
    printf 'sha256=%s\n' "$(shasum -a 256 "$final_file" | awk '{print $1}')"
  } > "$proof_path"
  assert_file_nonempty "$proof_path"
}

verify_outer_recording() {
  local agent="$1"
  local cast_path="$2"
  local webm_path="$3"
  local webm_envelope_path="$4"
  local review_webm_path="$5"
  local tui_marker

  assert_file_nonempty "$cast_path"
  assert_file_nonempty "$webm_path"
  assert_file_nonempty "$review_webm_path"
  assert_media_duration_at_least "$webm_path" 10 'outer full WebM'
  case "$agent" in
    codex) tui_marker='OpenAI Codex' ;;
    claude) tui_marker='Claude Code' ;;
    *) fail "unsupported outer recording agent: $agent" ;;
  esac

  grep -aF "$tui_marker" "$cast_path" >/dev/null || fail "outer cast does not show the $agent TUI: $cast_path"
  grep -aF 'agent-tty' "$cast_path" >/dev/null || fail "outer cast does not show nested agent-tty usage: $cast_path"

  local duration_ms
  duration_ms="$(jq -er '.result.durationMs' "$webm_envelope_path")"
  [[ "$duration_ms" =~ ^[0-9]+$ ]] || fail "outer WebM duration is not numeric in $webm_envelope_path"
  (( duration_ms >= 10000 )) || fail "outer WebM duration is ${duration_ms}ms (minimum 10000ms): $webm_path"
  jq -e --arg timing "$WEBM_TIMING" '.result.metadata.timingMode == $timing' "$webm_envelope_path" >/dev/null ||
    fail "outer WebM does not use $WEBM_TIMING timing: $webm_envelope_path"
}

run_agent_demo() {
  local agent="$1"
  require_command "$agent"
  clean_agent_outputs "$agent"

  local outer_home="$TEMP_ROOT/outer-home/$agent"
  local inner_home="$TEMP_ROOT/inner-home/$agent"
  local workspace="$TEMP_ROOT/workspaces/$agent"
  local xdg_root="$workspace/.xdg"
  local xdg_config_home="$xdg_root/config"
  local xdg_data_home="$xdg_root/data"
  local xdg_state_home="$xdg_root/state"
  local xdg_cache_home="$xdg_root/cache"
  local workspace_artifacts="$workspace/artifacts"
  local final_file="$workspace/demo-note.txt"
  local inner_cast="$workspace_artifacts/inner-nvim.cast"
  local inner_webm="$workspace_artifacts/inner-nvim.webm"
  local prompt_path="$ARTIFACTS_DIR/$agent-prompt.md"
  local transcript_path="$ARTIFACTS_DIR/$agent-agent-transcript.txt"
  local final_message_path="$ARTIFACTS_DIR/$agent-final-message.txt"
  local outer_cast_path="$ARTIFACTS_DIR/$agent-outer.cast"
  local outer_full_webm_path="$ARTIFACTS_DIR/$agent-outer-full.webm"
  local outer_review_webm_path="$ARTIFACTS_DIR/$agent-outer.webm"
  local outer_review_raw_webm_path="$TEMP_ROOT/$agent-outer-review-accelerated.webm"
  local outer_review_envelope_path="$TEMP_ROOT/$agent-outer-record-review-webm.json"
  local inner_helper_path="$workspace/run-inner-nvim-proof.sh"
  local runner_path="$workspace/run-$agent.sh"

  mkdir -p "$outer_home" "$inner_home" "$workspace" "$workspace_artifacts" "$xdg_config_home" "$xdg_data_home" "$xdg_state_home" "$xdg_cache_home"
  git -C "$workspace" init -q
  printf '# agent-tty dogfood workspace\n' > "$workspace/README.md"
  write_inner_helper "$inner_helper_path" "$workspace" "$inner_home" "$final_file" "$inner_cast" "$inner_webm" "$xdg_config_home" "$xdg_data_home" "$xdg_state_home" "$xdg_cache_home"
  render_prompt "$prompt_path" "$workspace" "$inner_home" "$final_file" "$inner_cast" "$inner_webm" "$inner_helper_path" "$xdg_config_home" "$xdg_data_home" "$xdg_state_home" "$xdg_cache_home"
  write_runner "$agent" "$runner_path" "$workspace" "$prompt_path"

  log "starting outer $agent recording"
  local create_json
  capture_json_var \
    create_json \
    agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" \
    create --json --cwd "$workspace" --cols 120 --rows 36 --name "agent-uses-agent-tty-$agent" \
    --env "PATH=$PATH" \
    --env "AGENT_TTY_HOME=$inner_home" \
    -- /bin/bash "$runner_path"
  printf '%s\n' "$create_json" > "$BUNDLE_DIR/$agent-outer-create.json"
  CURRENT_OUTER_HOME="$outer_home"
  CURRENT_OUTER_SESSION_ID="$(printf '%s\n' "$create_json" | jq -er '.result.sessionId')"

  acknowledge_startup_prompt_if_present "$outer_home" "$CURRENT_OUTER_SESSION_ID" "$BUNDLE_DIR/$agent-startup-prompt.json"
  wait_for_agent_proof "$outer_home" "$CURRENT_OUTER_SESSION_ID" "$final_file" "$inner_cast" "$inner_webm"

  # Capture the thumbnail before leaving the TUI so README links show the agent UI,
  # not the shell prompt restored after alt-screen exit.
  sleep 3

  local captured_live_thumbnail=0
  if try_capture_outer_thumbnail \
    "$outer_home" \
    "$CURRENT_OUTER_SESSION_ID" \
    "$BUNDLE_DIR/$agent-outer-screenshot.json" \
    "$ARTIFACTS_DIR/$agent-thumbnail.png"; then
    captured_live_thumbnail=1
  fi

  stop_outer_agent_tui "$agent" "$outer_home" "$CURRENT_OUTER_SESSION_ID" "$BUNDLE_DIR/$agent-outer-wait-exit.json"

  local exit_code
  exit_code="$(jq -r '.result.exitCode // "unknown"' "$BUNDLE_DIR/$agent-outer-wait-exit.json")"

  run_json_file \
    "$BUNDLE_DIR/$agent-outer-snapshot.json" \
    agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" \
    snapshot "$CURRENT_OUTER_SESSION_ID" --format text --include-scrollback --json
  jq -r '.result.text' "$BUNDLE_DIR/$agent-outer-snapshot.json" > "$ARTIFACTS_DIR/$agent-outer-snapshot.txt"
  assert_file_nonempty "$ARTIFACTS_DIR/$agent-outer-snapshot.txt"
  cp "$ARTIFACTS_DIR/$agent-outer-snapshot.txt" "$transcript_path"
  printf 'Interactive %s TUI recording captured in %s-outer.cast, %s-outer-full.webm, and the trimmed review cut %s-outer.webm.\n' "$agent" "$agent" "$agent" "$agent" > "$final_message_path"

  if [[ "$captured_live_thumbnail" == '0' ]]; then
    try_capture_outer_thumbnail \
      "$outer_home" \
      "$CURRENT_OUTER_SESSION_ID" \
      "$BUNDLE_DIR/$agent-outer-screenshot.json" \
      "$ARTIFACTS_DIR/$agent-thumbnail.png" || fail "failed to capture outer thumbnail for $agent"
  fi

  run_json_file \
    "$BUNDLE_DIR/$agent-outer-record-cast.json" \
    agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" \
    record export "$CURRENT_OUTER_SESSION_ID" --format asciicast --out "$outer_cast_path" --json
  run_json_file \
    "$BUNDLE_DIR/$agent-outer-record-webm.json" \
    agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" \
    record export "$CURRENT_OUTER_SESSION_ID" --format webm --timing "$WEBM_TIMING" --out "$outer_full_webm_path" --json
  run_json_file \
    "$outer_review_envelope_path" \
    agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" \
    record export "$CURRENT_OUTER_SESSION_ID" --format webm --timing accelerated --out "$outer_review_raw_webm_path" --json
  slow_outer_webm_for_review "$outer_review_raw_webm_path" "$outer_review_webm_path"
  verify_outer_recording "$agent" "$outer_cast_path" "$outer_full_webm_path" "$BUNDLE_DIR/$agent-outer-record-webm.json" "$outer_review_webm_path"

  run_json_file \
    "$BUNDLE_DIR/$agent-outer-destroy.json" \
    agent-tty --home "$outer_home" --timeout-ms "$OUTER_TIMEOUT_MS" \
    destroy "$CURRENT_OUTER_SESSION_ID" --json
  CURRENT_OUTER_HOME=""
  CURRENT_OUTER_SESSION_ID=""

  # 130 is SIGINT, expected when the script uses Ctrl+C to close a TUI.
  [[ "$exit_code" == '0' || "$exit_code" == '130' ]] || fail "$agent exited with code $exit_code; see $ARTIFACTS_DIR/$agent-outer.cast"
  verify_agent_outputs "$agent" "$workspace" "$final_file" "$inner_cast" "$inner_webm"
  log "completed $agent proof"
}

main() {
  parse_args "$@"
  require_command git
  require_command jq
  require_command node
  require_command npm
  require_command ffmpeg
  require_command ffprobe
  require_command nvim
  require_command shasum

  TEMP_ROOT="$(mktemp -d -t agent-uses-agent-tty.XXXXXX)"
  INSTALL_PREFIX="$TEMP_ROOT/install"
  mkdir -p "$INSTALL_PREFIX" "$ARTIFACTS_DIR"

  install_local_agent_tty
  write_environment_file

  local agent
  while IFS= read -r agent; do
    run_agent_demo "$agent"
  done < <(selected_agents)

  log "artifacts written to $ARTIFACTS_DIR"
}

main "$@"
