# Week 5 CLI/config parity proof bundle

This directory captures a 2026-03-23 dogfood pass for the Week 5 CLI/config parity slice under an isolated `AGENT_TERMINAL_HOME` (`/tmp/agent-terminal-week5-config-parity.rDdjw2`).

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
4. **Reviewable artifacts**
   - `screenshot.png` is the copied terminal screenshot from the renderer artifact path recorded in `screenshot-result.json`.
   - `type-flow.cast` is the exported asciicast from `record-export.json`.

## Important review notes

- `doctor` returned exit code `1` in both doctor captures because this workspace is running Node `22.19.0` while the repo declares `>=24 <25`. The JSON envelopes still prove the CLI booted, loaded the isolated home, and exercised renderer checks.
- The requested config used `"defaultProfile": "my-config-profile"`, which is accepted as config data for context loading, but the actual screenshot proof uses the root override `--profile reference-light` so the renderer runs with a known built-in profile and visibly proves root-flag precedence.
- `commands.sh` records the exact commands used. In this workspace, `npx tsx src/cli/main.ts ...` was blocked by tsx's interaction with an untrusted local `mise.toml`, so the run used the equivalent local invocation `/usr/local/nvm/versions/node/v22.19.0/bin/node --import tsx src/cli/main.ts ...` instead.

## Suggested review order

1. Read `config.json`.
2. Check `doctor-config.json` and `doctor-log-level-warn.json` alongside their `.exit.txt` files.
3. Check the three `create-*.json` / `inspect-*.json` pairs for idle-timeout precedence.
4. Check `type-no-newline.json`, `type-append-newline.json`, `wait-after-append-newline.json`, `snapshot-text.json`, and `screenshot.png`.
5. Open `type-flow.cast` if you want the end-to-end recording.
