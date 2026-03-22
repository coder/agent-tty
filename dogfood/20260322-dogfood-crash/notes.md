# Scenario G — abnormal exit dogfood

## Outcome

- Scenario completed end-to-end.
- `inspect` after crash reported `status: exited` and `exitCode: 1`.
- `inspect` after destroy reported `status: destroyed`.
- Pre/post crash snapshots preserved the same rendered lines, including `CRASH DEMO EXITING`.
- Pre/post crash screenshots had the same SHA-256: `b2c189b253a8ac783c7018ffe588a376f5f8ec19913061cffadf8f96c001363a`.
- Asciicast export recorded `6` output events and WebM export was `24787` bytes.

## Review answers

1. **Is the failure visible in inspect?** Yes — `status=exited`, `exitCode=1`, `exitSignal=null`.
2. **Are artifacts preserved after the crash?** Yes — snapshot, screenshot, `.cast`, and `.webm` all exported successfully after exit.
3. **Does offline replay still produce valid snapshots/screenshots?** Yes — post-crash replay matched the pre-crash terminal state.
4. **Does the .cast contain the full output including `CRASH DEMO EXITING`?** Yes — verified by grepping the exported cast.
5. **After destroy, does inspect show `destroyed` status?** Yes.

## Snapshot comparison

- Pre-crash `capturedAtSeq`: 6
- Post-crash `capturedAtSeq`: 6
- Visible line 0: `CRASH DEMO START`
- Visible line 3: `CRASH DEMO EXITING`

## Commands

| Label | Exit | Output | Command |
|---|---:|---|---|
| `create` | 0 | `01-create.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts create --json npx tsx test/fixtures/apps/crash-demo/main.ts` |
| `wait_start` | 0 | `02-wait-start.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts wait 01KMBTTKERFNKCZBKESJPTKY4N --text CRASH\ DEMO\ START` |
| `screenshot_pre` | 0 | `03-screenshot-pre.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts screenshot 01KMBTTKERFNKCZBKESJPTKY4N --json` |
| `snapshot_pre` | 0 | `04-snapshot-pre.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts snapshot 01KMBTTKERFNKCZBKESJPTKY4N --json` |
| `wait_exit` | 0 | `05-wait-exit.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts wait 01KMBTTKERFNKCZBKESJPTKY4N --exit` |
| `inspect_post_crash` | 0 | `06-inspect-post-crash.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts inspect 01KMBTTKERFNKCZBKESJPTKY4N --json` |
| `snapshot_post` | 0 | `07-snapshot-post-crash.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts snapshot 01KMBTTKERFNKCZBKESJPTKY4N --json` |
| `screenshot_post` | 0 | `08-screenshot-post-crash.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts screenshot 01KMBTTKERFNKCZBKESJPTKY4N --json` |
| `export_cast` | 0 | `09-record-export-cast.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts record export 01KMBTTKERFNKCZBKESJPTKY4N --format asciicast --out dogfood/20260322-dogfood-crash/artifacts/post-crash.cast --json` |
| `export_webm` | 0 | `10-record-export-webm.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts record export 01KMBTTKERFNKCZBKESJPTKY4N --format webm --out dogfood/20260322-dogfood-crash/artifacts/post-crash.webm --json` |
| `destroy` | 0 | `11-destroy.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts destroy 01KMBTTKERFNKCZBKESJPTKY4N --json` |
| `inspect_destroyed` | 0 | `12-inspect-destroyed.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.BMAS1ZBaGW npx tsx src/cli/main.ts inspect 01KMBTTKERFNKCZBKESJPTKY4N --json` |
| `home_tree` | 0 | `13-home-tree.txt` | `find /tmp/tmp.BMAS1ZBaGW -maxdepth 4 -print` |
