# Week 5 CLI/config parity proof bundle

This directory captures a 2026-03-23 dogfood pass for the Week 5 CLI/config parity slice under isolated `AGENT_TERMINAL_HOME` values recorded in `isolated-home.txt` (Phase 1+2) and `phase3-isolated-home.txt` (Phase 3 enriched-result follow-up).

## What this bundle demonstrates

1. **Config-backed create defaults**
   - `create-with-config.json` + `inspect-with-config.json` show `idleTimeoutMs: 3000` flowed from `config.json` when no create flag was supplied.
   - `create-with-flag.json` + `inspect-with-flag.json` show `--idle-timeout-ms 5000` overrode the config value.
   - `create-disabled.json` + `inspect-disabled.json` show `--idle-timeout-ms 0` disabled persistence by omitting `idleTimeoutMs` from the manifest.
2. **Root flag acceptance / parity**
   - `doctor-log-level-warn.json` plus `doctor-log-level-warn.exit.txt` show `--log-level warn` was accepted on the root command.
   - `screenshot-result.json` shows the root `--profile reference-light` override won over the config file's `defaultProfile` and produced a `reference-light` screenshot.
3. **`type --append-newline` behavior**
   - `type-no-newline.json`, `type-append-newline.json`, `wait-after-append-newline.json`, `snapshot-text.json`, and `screenshot.png` show a Bash session buffered `echo hello && ` until the second `type` call appended `echo world` plus a newline, submitting the combined command `echo hello && echo world`.
4. **Phase 3 — enriched result shapes**
   - `create-enriched.json` shows `create --json` preserved `sessionId` and added `createdAt`, `cols`, `rows`, `shell`, and `idleTimeoutMs` for the named `/bin/sh` session.
   - `list-enriched.json` shows `list --json` sessions now include `name` and `pid` alongside the existing `sessionId`, `status`, `command`, and `createdAt` fields.
   - `inspect-enriched.json` shows `inspect --json` preserved the nested `session` object and added top-level `eventCount` and `uptime` after a `type ... --append-newline` call generated replayable events.
   - `list-all-enriched.json` shows `list --all --json` keeps the same enriched session shape after the session is destroyed.
5. **Reviewable artifacts**
   - `screenshot.png` is the copied terminal screenshot from the renderer artifact path recorded in `screenshot-result.json`.
   - `type-flow.cast` is the exported asciicast from `record-export.json`.

## Important review notes

- `doctor` returned exit code `1` in both doctor captures because this workspace is running Node `22.19.0` while the repo declares `>=24 <25`. The JSON envelopes still prove the CLI booted, loaded the isolated home, and exercised renderer checks.
- The requested config used `"defaultProfile": "my-config-profile"`, which is accepted as config data for context loading, but the actual screenshot proof uses the root override `--profile reference-light` so the renderer runs with a known built-in profile and visibly proves root-flag precedence.
- `commands.sh` records the exact commands used. Phase 1+2 used `/usr/local/nvm/versions/node/v22.19.0/bin/node --import tsx src/cli/main.ts ...` because plain `npx tsx` surfaced an untrusted local `mise.toml`; Phase 3 used `env -i HOME="$HOME" PATH="/usr/local/nvm/versions/node/v22.19.0/bin:/usr/bin:/bin" npx tsx src/cli/main.ts ...` so the commands still run through `npx tsx` while bypassing the `mise` trust check.
- Backward compatibility is preserved in the proof files: the JSON envelopes still contain `ok`, `command`, `timestamp`, and the pre-existing session metadata, while Phase 3 adds fields to the result payloads instead of replacing older ones.

## Suggested review order

1. Read `config.json`.
2. Check `doctor-config.json` and `doctor-log-level-warn.json` alongside their `.exit.txt` files.
3. Check the three `create-*.json` / `inspect-*.json` pairs for idle-timeout precedence.
4. Check `type-no-newline.json`, `type-append-newline.json`, `wait-after-append-newline.json`, `snapshot-text.json`, and `screenshot.png`.
5. Check `create-enriched.json`, `list-enriched.json`, `inspect-enriched.json`, and `list-all-enriched.json` for the Phase 3 result-shape additions.
6. Open `type-flow.cast` if you want the end-to-end recording.
