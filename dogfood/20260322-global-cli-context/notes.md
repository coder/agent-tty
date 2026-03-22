# CLI context / exit code smoke test

Commands exercised in a replayable terminal capture (`transcript.log` + `timing.log`):

1. `node --import tsx ./src/cli/main.ts --no-color version`
2. `AGENT_TERMINAL_HOME=<env-home> node --import tsx ./src/cli/main.ts --home <override-home> create --json -- /bin/sh -c 'exec cat'`
3. `AGENT_TERMINAL_HOME=<env-home> node --import tsx ./src/cli/main.ts --home <override-home> inspect <session-id>`
4. `AGENT_TERMINAL_HOME=<env-home> node --import tsx ./src/cli/main.ts --home <override-home> list`
5. `AGENT_TERMINAL_HOME=<env-home> node --import tsx ./src/cli/main.ts inspect missing-session --json`
6. `AGENT_TERMINAL_HOME=<env-home> node --import tsx ./src/cli/main.ts --home <override-home> destroy <session-id> --force --json`

Observed results:

- `--no-color version` emitted plain human-readable text with no ANSI escapes.
- `--home` created and inspected a session under the override home, despite `AGENT_TERMINAL_HOME` pointing elsewhere.
- `inspect missing-session --json` returned `SESSION_NOT_FOUND` with process exit code `3`.

Reviewer artifacts:

- `smoke-1-version-create.svg`
- `smoke-2-inspect-list.svg`
- `smoke-3-error-exitcode.svg`
- `transcript.log`
- `timing.log`
