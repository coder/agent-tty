# agent-tty verification map

This folder is the maintained source for verifying what agent-tty users see. Read this index before you drive the CLI, then use the matching feature file as the recipe.

## Baseline preconditions

- Start a run with `ENV=$(.agents/skills/verify-agent-tty/scripts/start-run.sh <name>)` and begin every shell with `. "$ENV"`.
- `.agents/skills/verify-agent-tty/scripts/doctor.sh "$ENV"` exits 0.
- `att` is the built CLI of this checkout, and `AGENT_TTY_HOME` is the run's own Home. Never drive `~/.agent-tty` or a Home that another run or a person uses.
- Commands run from the repo root, so the fixture path `test/fixtures/apps/<app>/main.ts` resolves.

## Driving conventions

- Add `--json` to every command and read the envelope with `jq`. Do not parse the human-readable output.
- `env.sh` turns on `pipefail`, so in `att ... | tee file` the exit code is the CLI's. In a shell that did not source it, read `${PIPESTATUS[0]}`.
- Give every `wait` a `--timeout <ms>`, and every batch `wait` step a `"timeout"`. The default is 10 minutes.
- Wait on screen content (`wait --text`, `--regex`, `--screen-stable-ms`, `--exit`), never on `sleep`.
- Prefer stable handles: the prompt `READY>` and the `ECHO: <line>` replies of `hello-prompt`, session IDs from `create`, and the key hints in the dashboard footer.
- Treat every command as literal. Keep quoted text and flags unchanged.
- Destroy the sessions that a recipe creates, or leave that to `cleanup.sh`. Never delete proof.

## Proof and skip reporting

- Make the feature's evidence folder first (`mkdir -p "$EVIDENCE/<folder>"`, as each recipe's Preconditions say), then save each command's envelope there with `tee`, and note its exit code. `tee` into a missing folder prints the envelope and loses the file without an error you would notice.
- After each input step, capture the screen (`snapshot --format text --json`), so the proof shows the action and the state it produced.
- Check the files on disk next to the envelope: `session.json`, `events.jsonl`, `artifacts/manifest.json`.
- Open each PNG you cite and confirm what it shows.
- Record the feature ID and the entry point next to each artifact.
- Report an entry point that you could not reach with the command you tried and the precondition that was missing. Do not report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph that describes what the user sees. It then has exactly four H2 sections, in this order:

1. `Sub-features` lists short IDs, one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with att` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and its observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Session lifecycle](./session-lifecycle.md): create, list, inspect, destroy, gc, and the Home Registry.
- [Input and waits](./run-and-wait.md): waited `run`, `type`, `paste`, `send-keys`, `mark`, and every `wait` condition.
- [Batch](./batch.md): ordered input and wait steps with Wait Baselines, fail-fast and `--keep-going`.
- [Artifacts](./artifacts.md): `snapshot`, `screenshot`, `record export` (asciicast and WebM) and `record diff`.
- [Dashboard](./dashboard.md): the read-only live TUI of a Home's sessions.

Not mapped yet: `resize`, `signal`, `doctor` on its own, `version`, `skills list|get|path`, `home forget`, the `--renderer` and `--profile` global options.
