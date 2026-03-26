#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

BUNDLE_DIR='dogfood/20260325-week8-bundle-validation'
LOG_DIR="$BUNDLE_DIR/logs"
SCREENSHOT_DIR="$BUNDLE_DIR/screenshots"
RECORDING_DIR="$BUNDLE_DIR/recordings"
VIDEO_DIR="$BUNDLE_DIR/videos"
SNAPSHOT_DIR="$BUNDLE_DIR/snapshots"
STATUS_TSV="$BUNDLE_DIR/command-status.tsv"
SUMMARY_JSON="$BUNDLE_DIR/proof-summary.json"

mkdir -p "$LOG_DIR" "$SCREENSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" "$SNAPSHOT_DIR"
find "$LOG_DIR" "$SCREENSHOT_DIR" "$RECORDING_DIR" "$VIDEO_DIR" "$SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -type f -delete
rm -f "$BUNDLE_DIR/index.html" "$STATUS_TSV" "$SUMMARY_JSON"
touch "$RECORDING_DIR/.gitkeep" "$VIDEO_DIR/.gitkeep" "$SNAPSHOT_DIR/.gitkeep"

pretty_json() {
  local path="$1"
  node -e "const fs=require('fs'); const path=process.argv[1]; const text=fs.readFileSync(path,'utf8').trim(); if (text.length === 0) process.exit(0); const value=JSON.parse(text); fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');" "$path"
}

record_status() {
  local step="$1"
  local command="$2"
  local exit_code="$3"
  local status="$4"
  printf '%s\t%s\t%s\t%s\n' "$step" "$command" "$exit_code" "$status" >> "$STATUS_TSV"
}

run_json_step() {
  local step="$1"
  local command="$2"
  local expectation="$3"
  local stdout_path="$LOG_DIR/$step.json"
  local stderr_path="$LOG_DIR/$step.stderr.txt"
  local exit_code=0

  set +e
  eval "$command" >"$stdout_path" 2>"$stderr_path"
  exit_code=$?
  set -e

  if [ -s "$stdout_path" ]; then
    pretty_json "$stdout_path"
  fi

  case "$expectation" in
    pass)
      if [ "$exit_code" -eq 0 ]; then
        record_status "$step" "$command" "$exit_code" 'pass'
        return 0
      fi
      record_status "$step" "$command" "$exit_code" 'fail'
      return "$exit_code"
      ;;
    expected-fail)
      if [ "$exit_code" -ne 0 ]; then
        record_status "$step" "$command" "$exit_code" 'expected-fail'
        return 0
      fi
      record_status "$step" "$command" "$exit_code" 'unexpected-pass'
      return 1
      ;;
    *)
      printf 'unsupported expectation: %s\n' "$expectation" >&2
      return 1
      ;;
  esac
}

run_text_step() {
  local step="$1"
  local command="$2"
  local expectation="$3"
  local stdout_path="$LOG_DIR/$step.txt"
  local stderr_path="$LOG_DIR/$step.stderr.txt"
  local exit_code=0

  set +e
  eval "$command" >"$stdout_path" 2>"$stderr_path"
  exit_code=$?
  set -e

  case "$expectation" in
    pass)
      if [ "$exit_code" -eq 0 ]; then
        record_status "$step" "$command" "$exit_code" 'pass'
        return 0
      fi
      record_status "$step" "$command" "$exit_code" 'fail'
      return "$exit_code"
      ;;
    expected-fail)
      if [ "$exit_code" -ne 0 ]; then
        record_status "$step" "$command" "$exit_code" 'expected-fail'
        return 0
      fi
      record_status "$step" "$command" "$exit_code" 'unexpected-pass'
      return 1
      ;;
    *)
      printf 'unsupported expectation: %s\n' "$expectation" >&2
      return 1
      ;;
  esac
}

capture_review_screenshot() {
  local stdout_path="$LOG_DIR/05-review-page-screenshot.json"
  local stderr_path="$LOG_DIR/05-review-page-screenshot.stderr.txt"
  local command="node --input-type=module <embedded playwright screenshot>"
  local exit_code=0

  set +e
  node --input-type=module >"$stdout_path" 2>"$stderr_path" <<'EOS'
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const bundleDir = resolve('dogfood/20260325-week8-bundle-validation');
const screenshotPath = resolve('dogfood/20260325-week8-bundle-validation/screenshots/01-review-page.png');
const pageUrl = new URL(`file://${resolve('dogfood/20260325-week8-bundle-validation/index.html')}`);
const launchOptions = { headless: true, args: ['--no-sandbox'] };

try {
  await access('/usr/bin/google-chrome');
  launchOptions.executablePath = '/usr/bin/google-chrome';
} catch {
  // Fall back to Playwright-managed Chromium when the system browser is absent.
}

const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(pageUrl.toString());
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(
    JSON.stringify(
      {
        ok: true,
        bundleDir,
        pageUrl: pageUrl.toString(),
        screenshotPath,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
EOS
  exit_code=$?
  set -e

  if [ -s "$stdout_path" ]; then
    pretty_json "$stdout_path"
  fi

  if [ "$exit_code" -eq 0 ]; then
    record_status '05-review-page-screenshot' "$command" "$exit_code" 'pass'
    return 0
  fi

  record_status '05-review-page-screenshot' "$command" "$exit_code" 'fail'
  return "$exit_code"
}

write_summary_json() {
  node - "$SUMMARY_JSON" <<'EOS'
const fs = require('fs');
const outputPath = process.argv[2];
const summary = {
  bundle: '20260325-week8-bundle-validation',
  generatedAt: new Date().toISOString(),
  summary: 'Week 8 validate-bundle proof summary for valid, invalid, existing-bundle, and self-validation scenarios.',
  cases: [
    { step: '01-valid-pass', expectation: 'pass', artifact: 'logs/01-valid-pass.json' },
    { step: '02-invalid-fail', expectation: 'expected-fail', artifact: 'logs/02-invalid-fail.json' },
    { step: '03-brief-reference-week7-a-fail', expectation: 'expected-fail', artifact: 'logs/03-brief-reference-week7-a-fail.json' },
    { step: '04-existing-legacy-pass', expectation: 'pass', artifact: 'logs/04-existing-legacy-pass.json' },
    { step: '05-review-page-screenshot', expectation: 'pass', artifact: 'logs/05-review-page-screenshot.json' },
    { step: '06-self-pass', expectation: 'pass', artifact: 'logs/06-self-pass.json' },
    { step: '07-review-self', expectation: 'pass', artifact: 'logs/07-review-self.txt' },
  ],
};
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n');
EOS
}

printf 'step\tcommand\texit_code\tstatus\n' > "$STATUS_TSV"

VALID_ROOT="$(mktemp -d /tmp/agent-terminal-week8-valid.XXXXXX)"
INVALID_ROOT="$(mktemp -d /tmp/agent-terminal-week8-invalid.XXXXXX)"
EXISTING_ROOT="$(mktemp -d /tmp/agent-terminal-week8-existing.XXXXXX)"
VALID_BUNDLE="$VALID_ROOT/valid-sample"
INVALID_BUNDLE="$INVALID_ROOT/invalid-sample"
EXISTING_BUNDLE="$EXISTING_ROOT/20260319-lifecycle"

cleanup() {
  rm -rf "$VALID_ROOT" "$INVALID_ROOT" "$EXISTING_ROOT"
}
trap cleanup EXIT

mkdir -p "$VALID_BUNDLE" "$INVALID_BUNDLE"
printf '{"ok":true}\n' > "$VALID_BUNDLE/01-sample.json"
printf '# Notes\n' > "$VALID_BUNDLE/notes.md"
npm run --silent review-bundle -- "$VALID_BUNDLE" >/dev/null 2>/dev/null

cp -R dogfood/20260319-lifecycle "$EXISTING_BUNDLE"
npm run --silent review-bundle -- "$EXISTING_BUNDLE" >/dev/null 2>/dev/null

run_json_step '01-valid-pass' "npm run --silent validate-bundle -- \"$VALID_BUNDLE\" --profile contract-reporting" 'pass'
run_json_step '02-invalid-fail' "npm run --silent validate-bundle -- \"$INVALID_BUNDLE\" --profile contract-reporting" 'expected-fail'
run_json_step '03-brief-reference-week7-a-fail' 'npm run --silent validate-bundle -- dogfood/20260325-week7-a-cli-parity --profile contract-reporting' 'expected-fail'
run_json_step '04-existing-legacy-pass' "npm run --silent validate-bundle -- \"$EXISTING_BUNDLE\" --profile contract-reporting" 'pass'

write_summary_json
npm run --silent review-bundle -- "$BUNDLE_DIR" >/dev/null 2>/dev/null
capture_review_screenshot
run_json_step '06-self-pass' "npm run --silent validate-bundle -- \"$BUNDLE_DIR\" --profile contract-reporting" 'pass'
run_text_step '07-review-self' "npm run --silent review-bundle -- \"$BUNDLE_DIR\"" 'pass'
