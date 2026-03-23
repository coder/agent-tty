# Scenario A — hello-prompt

- **Date:** 2026-03-22
- **Bundle:** `dogfood/20260322-dogfood-hello-prompt/`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **Fixture:** `npx tsx test/fixtures/apps/hello-prompt/main.ts`
- **Session ID:** `01KMBTVTGGDAP71DH9RBSR4HBM`
- **Isolated home:** `/tmp/tmp.hs8aHP3uD3`

## Outcome

Scenario A completed successfully. The fixture reached the READY prompt, echoed `hello world`, exited on the `exit` command, and remained inspectable for post-exit artifact export.

## Review

- **Echo matched expectations:** Yes — `06-wait-echo.json` matched the exact echoed string.
- **Lifecycle completed:** Yes — `13-inspect-final.json` reports status `exited`.

## Issues found

- None during the scenario run.

## Artifacts

- `03-snapshot-initial.json`
- `07-screenshot-echo.json` + `screenshots/01-echoed-result.png`
- `11-record-export-cast.json` + `recordings/hello-prompt.cast`
- `12-record-export-webm.json` + `videos/hello-prompt.webm`
- `13-inspect-final.json`
- `command-log.tsv`
- `manifest.json`

## Command log

| Step                    | Exit code | Command                                                                                                                                                                                                                          |
| ----------------------- | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-create`             |         0 | `npx tsx src/cli/main.ts create --json -- npx tsx test/fixtures/apps/hello-prompt/main.ts `                                                                                                                                      |
| `02-wait-ready`         |         0 | `npx tsx src/cli/main.ts wait 01KMBTVTGGDAP71DH9RBSR4HBM --text READY\> --json `                                                                                                                                                 |
| `03-snapshot-initial`   |         0 | `npx tsx src/cli/main.ts snapshot 01KMBTVTGGDAP71DH9RBSR4HBM --json `                                                                                                                                                            |
| `04-type-hello`         |         0 | `npx tsx src/cli/main.ts type 01KMBTVTGGDAP71DH9RBSR4HBM hello\ world --json `                                                                                                                                                   |
| `05-send-enter`         |         0 | `npx tsx src/cli/main.ts send-keys 01KMBTVTGGDAP71DH9RBSR4HBM Enter --json `                                                                                                                                                     |
| `06-wait-echo`          |         0 | `npx tsx src/cli/main.ts wait 01KMBTVTGGDAP71DH9RBSR4HBM --text ECHO:\ hello\ world --json `                                                                                                                                     |
| `07-screenshot-echo`    |         0 | `npx tsx src/cli/main.ts screenshot 01KMBTVTGGDAP71DH9RBSR4HBM --json `                                                                                                                                                          |
| `08-type-exit`          |         0 | `npx tsx src/cli/main.ts type 01KMBTVTGGDAP71DH9RBSR4HBM exit --json `                                                                                                                                                           |
| `09-send-enter-exit`    |         0 | `npx tsx src/cli/main.ts send-keys 01KMBTVTGGDAP71DH9RBSR4HBM Enter --json `                                                                                                                                                     |
| `10-wait-exit`          |         0 | `npx tsx src/cli/main.ts wait 01KMBTVTGGDAP71DH9RBSR4HBM --exit --json `                                                                                                                                                         |
| `11-record-export-cast` |         0 | `npx tsx src/cli/main.ts record export 01KMBTVTGGDAP71DH9RBSR4HBM --format asciicast --out /home/coder/.mux/src/agent-terminal/agent_exec_3a3efb7ac5/dogfood/20260322-dogfood-hello-prompt/recordings/hello-prompt.cast --json ` |
| `12-record-export-webm` |         0 | `npx tsx src/cli/main.ts record export 01KMBTVTGGDAP71DH9RBSR4HBM --format webm --out /home/coder/.mux/src/agent-terminal/agent_exec_3a3efb7ac5/dogfood/20260322-dogfood-hello-prompt/videos/hello-prompt.webm --json `          |
| `13-inspect-final`      |         0 | `npx tsx src/cli/main.ts inspect 01KMBTVTGGDAP71DH9RBSR4HBM --json `                                                                                                                                                             |
