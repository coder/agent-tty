# Week 4 CLI features dogfood

## Outcome

- `--home` worked: the created session appeared under the custom home and `list --json` returned it.
- `--env` and `--name` worked: `inspect --json` showed `name=test-session`, env keys `FOO` and `BAZ`, and `term=xterm-256color`.
- `type --file` worked and `wait --text 'ECHO: hello from file'` matched.
- `wait --cursor-row` worked with `cursorRow=0` and `cursorCol=7`.
- Follow-up `wait --cursor-row 0 --cursor-col 7` also matched successfully.
- Exit codes matched expectations: `inspect nonexistent-session-id` exited 3 and `wait --json` without a session id exited 2.

## Specific findings

1. **`--home`**: Passed. The isolated custom home contained `sessions/01KMBTWDCCX4PKCK4FVQ5DN7T2/session.json` and `events.jsonl`.
2. **`--env` / `--name`**: Passed. Manifest fields persisted in `inspect` output.
3. **`--file`**: Passed. The screenshot shows the typed file text echoed back. Note: because the file was created with `echo`, it included a trailing newline; the fixture therefore processed an extra blank line after the explicit `Enter` key.
4. **`--cursor-row` / `--cursor-col`**: Passed. `cursor-row` matched row 0; follow-up `cursor-row + cursor-col` matched row 0 / col 7.
5. **Exit codes**: Passed. Missing session returned `SESSION_NOT_FOUND` with process exit 3; missing required arg returned usage text and process exit 2.

## Notable non-blocking issue

- `npm ci` succeeded but emitted an `EBADENGINE` warning because the workspace runtime was Node 22.19.0 while `package.json` requires Node >=24 <25. This did not block the CLI dogfood runs.

## Commands

| Label                   | Exit | Output                          | Command                                                                                                                                                                                                   |
| ----------------------- | ---: | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home_create`           |    0 | `01-home-create.json`           | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts --home /tmp/tmp.gHWn0YVbwd create --json npx tsx test/fixtures/apps/hello-prompt/main.ts`                                            |
| `home_tree`             |    0 | `02-home-tree.txt`              | `find /tmp/tmp.gHWn0YVbwd -maxdepth 4 -print`                                                                                                                                                             |
| `home_list`             |    0 | `03-home-list.json`             | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts --home /tmp/tmp.gHWn0YVbwd list --json`                                                                                              |
| `home_type_exit`        |    0 | `04-home-type-exit.json`        | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts --home /tmp/tmp.gHWn0YVbwd type 01KMBTWDCCX4PKCK4FVQ5DN7T2 exit --json`                                                              |
| `home_send_enter`       |    0 | `05-home-send-enter.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts --home /tmp/tmp.gHWn0YVbwd send-keys 01KMBTWDCCX4PKCK4FVQ5DN7T2 Enter --json`                                                        |
| `home_wait_exit`        |    0 | `06-home-wait-exit.json`        | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts --home /tmp/tmp.gHWn0YVbwd wait 01KMBTWDCCX4PKCK4FVQ5DN7T2 --exit`                                                                   |
| `home_destroy`          |    0 | `07-home-destroy.json`          | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts --home /tmp/tmp.gHWn0YVbwd destroy 01KMBTWDCCX4PKCK4FVQ5DN7T2 --json`                                                                |
| `named_create`          |    0 | `08-named-create.json`          | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts create --name test-session --env FOO=bar --env BAZ=qux --term xterm-256color --json npx tsx test/fixtures/apps/hello-prompt/main.ts` |
| `named_inspect`         |    0 | `09-named-inspect.json`         | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts inspect 01KMBTWMKH1NFA0BJ8E6X0WC54 --json`                                                                                           |
| `named_type_exit`       |    0 | `10-named-type-exit.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts type 01KMBTWMKH1NFA0BJ8E6X0WC54 exit --json`                                                                                         |
| `named_send_enter`      |    0 | `11-named-send-enter.json`      | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts send-keys 01KMBTWMKH1NFA0BJ8E6X0WC54 Enter --json`                                                                                   |
| `named_wait_exit`       |    0 | `12-named-wait-exit.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTWMKH1NFA0BJ8E6X0WC54 --exit`                                                                                              |
| `named_destroy`         |    0 | `13-named-destroy.json`         | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts destroy 01KMBTWMKH1NFA0BJ8E6X0WC54 --json`                                                                                           |
| `file_create`           |    0 | `14-file-create.json`           | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts create --json npx tsx test/fixtures/apps/hello-prompt/main.ts`                                                                       |
| `file_wait_ready`       |    0 | `15-file-wait-ready.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTWW202S16N3WQJXXFBZ0H --text READY\>`                                                                                      |
| `file_type`             |    0 | `16-file-type.json`             | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts type 01KMBTWW202S16N3WQJXXFBZ0H --file /tmp/dogfood-input.txt --json`                                                                |
| `file_send_enter`       |    0 | `17-file-send-enter.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts send-keys 01KMBTWW202S16N3WQJXXFBZ0H Enter --json`                                                                                   |
| `file_wait_echo`        |    0 | `18-file-wait-echo.json`        | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTWW202S16N3WQJXXFBZ0H --text ECHO:\ hello\ from\ file`                                                                     |
| `file_screenshot`       |    0 | `19-file-screenshot.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts screenshot 01KMBTWW202S16N3WQJXXFBZ0H --json`                                                                                        |
| `file_type_exit`        |    0 | `20-file-type-exit.json`        | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts type 01KMBTWW202S16N3WQJXXFBZ0H exit --json`                                                                                         |
| `file_send_enter_exit`  |    0 | `21-file-send-enter-exit.json`  | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts send-keys 01KMBTWW202S16N3WQJXXFBZ0H Enter --json`                                                                                   |
| `file_wait_exit`        |    0 | `22-file-wait-exit.json`        | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTWW202S16N3WQJXXFBZ0H --exit`                                                                                              |
| `file_destroy`          |    0 | `23-file-destroy.json`          | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts destroy 01KMBTWW202S16N3WQJXXFBZ0H --json`                                                                                           |
| `cursor_create`         |    0 | `24-cursor-create.json`         | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts create --json npx tsx test/fixtures/apps/hello-prompt/main.ts`                                                                       |
| `cursor_wait_ready`     |    0 | `25-cursor-wait-ready.json`     | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTX94V40WK8FE3SHE5M8ND --text READY\>`                                                                                      |
| `cursor_wait_row`       |    0 | `26-cursor-wait-row.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTX94V40WK8FE3SHE5M8ND --cursor-row 0 --timeout 5000 --json`                                                                |
| `cursor_type_exit`      |    0 | `27-cursor-type-exit.json`      | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts type 01KMBTX94V40WK8FE3SHE5M8ND exit --json`                                                                                         |
| `cursor_send_enter`     |    0 | `28-cursor-send-enter.json`     | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts send-keys 01KMBTX94V40WK8FE3SHE5M8ND Enter --json`                                                                                   |
| `cursor_wait_exit`      |    0 | `29-cursor-wait-exit.json`      | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTX94V40WK8FE3SHE5M8ND --exit`                                                                                              |
| `cursor_destroy`        |    0 | `30-cursor-destroy.json`        | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts destroy 01KMBTX94V40WK8FE3SHE5M8ND --json`                                                                                           |
| `inspect_missing`       |    3 | `31-inspect-missing.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts inspect nonexistent-session-id --json`                                                                                               |
| `wait_missing_id`       |    2 | `32-wait-missing-id.txt`        | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait --json`                                                                                                                         |
| `week4_home_tree`       |    0 | `33-week4-home-tree.txt`        | `find /tmp/tmp.CUFRxNmZtF -maxdepth 4 -print`                                                                                                                                                             |
| `cursor_col_create`     |    0 | `34-cursor-col-create.json`     | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts create --json npx tsx test/fixtures/apps/hello-prompt/main.ts`                                                                       |
| `cursor_col_wait_ready` |    0 | `35-cursor-col-wait-ready.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTZHW4XD4PWSFTE2KPMF2Q --text READY\>`                                                                                      |
| `cursor_col_wait`       |    0 | `36-cursor-col-wait.json`       | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTZHW4XD4PWSFTE2KPMF2Q --cursor-row 0 --cursor-col 7 --timeout 5000 --json`                                                 |
| `cursor_col_type_exit`  |    0 | `37-cursor-col-type-exit.json`  | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts type 01KMBTZHW4XD4PWSFTE2KPMF2Q exit --json`                                                                                         |
| `cursor_col_send_enter` |    0 | `38-cursor-col-send-enter.json` | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts send-keys 01KMBTZHW4XD4PWSFTE2KPMF2Q Enter --json`                                                                                   |
| `cursor_col_wait_exit`  |    0 | `39-cursor-col-wait-exit.json`  | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts wait 01KMBTZHW4XD4PWSFTE2KPMF2Q --exit`                                                                                              |
| `cursor_col_destroy`    |    0 | `40-cursor-col-destroy.json`    | `env AGENT_TERMINAL_HOME=/tmp/tmp.CUFRxNmZtF npx tsx src/cli/main.ts destroy 01KMBTZHW4XD4PWSFTE2KPMF2Q --json`                                                                                           |
