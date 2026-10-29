# Input and waits

A user sends input to a running program and waits until the screen shows the result: a waited `run` of a shell command, typed text, pasted text, key chords, and markers in the timeline. Each `wait` condition is checked against the rendered screen, not the raw output.

## Sub-features

- `input-run` runs a shell command and waits for its Run Completion.
- `input-type` types literal text, with or without a newline.
- `input-paste` pastes text as one bracketed paste.
- `input-keys` sends named keys and chords such as `Enter` and `Ctrl+C`.
- `input-mark` adds a labeled marker event to the timeline.
- `wait-text` waits for text on the screen.
- `wait-regex-cursor` waits for a regex on the cursor's row only.
- `wait-stable` waits until the visible screen has not changed for a time.
- `wait-idle` waits until the program has written nothing for a time.
- `wait-exit` waits for the program to exit and returns its exit code.
- `wait-timeout` gives up with `WAIT_TIMEOUT`.

## How to get to it (user POV)

- `agent-tty run <id> '<command>'`, with `--timeout <ms>`, `--no-wait`, `--file <path>`.
- `agent-tty type <id> '<text>'`, with `--append-newline`, `--file <path>`.
- `agent-tty paste <id> '<text>'`, `--file <path>`.
- `agent-tty send-keys <id> <key>...`.
- `agent-tty mark <id> <label>`.
- `agent-tty wait <id>` with one of `--text`, `--regex` (plus `--scope screen|cursor-line`), `--screen-stable-ms`, `--idle-ms`, `--cursor-row`/`--cursor-col`, `--exit`, and `--timeout`, `--after-seq`.

## Driving it with att

Preconditions:

- `mkdir -p "$EVIDENCE/input"` has run. The recipe saves its proof there.
- The baseline preconditions in the README hold.
- A shell session: `B=$(att create --json --env 'PS1=$ ' -- /bin/bash --noprofile --norc | jq -r .result.sessionId)`.
- A fixture session: `H=$(att create --json -- node --import tsx test/fixtures/apps/hello-prompt/main.ts | jq -r .result.sessionId)`, then `att wait "$H" --regex 'READY>$' --scope cursor-line --timeout 10000 --json` matches.

- **Waited run.** Run `att run "$B" 'printf "run-ok\n"' --json | tee "$EVIDENCE/input/run.json"`. `.result.accepted`, `.result.completed` are `true`, `.result.timedOut` is `false`, and `.result.marker` starts with `__AT_MARKER_`. Then `att snapshot "$B" --format text --json | jq -r .result.text` shows a line `run-ok`, and no marker text.
- **Run without waiting.** Run `att run "$B" "sleep 2; printf 'late-%s\n' done" --no-wait --json`, then `att wait "$B" --text late-done --timeout 10000 --json`. The run returns at once with `accepted: true` and a `seq`, and the wait matches about 2 seconds later, on the output line `late-done`. The `printf` keeps the text `late-done` out of the echoed command line.
- **Wait for idle output.** Run `att run "$B" 'for i in 1 2 3; do echo tick-$i; sleep 0.3; done' --no-wait --json`, then `att wait "$B" --idle-ms 1000 --timeout 10000 --json`. `.result.timedOut` is `false`, and a snapshot then shows `tick-3`.
- **Type.** Run `att type "$H" hello --append-newline --json`. `.result.seq` is a number. `att wait "$H" --text 'ECHO: hello' --timeout 10000 --json` returns `matched: true` and `matchedText: "ECHO: hello"`.
- **Paste.** Run `att paste "$H" pasted --json`, then `att send-keys "$H" Enter --json`. The second envelope has `accepted: ["Enter"]`. `att wait "$H" --text 'ECHO: pasted' --timeout 10000 --json` matches. The snapshot shows the input line as `READY> ^[[200~pasted^[[201~` (the paste is bracketed) and the reply as `ECHO: pasted`, without the markers.
- **Prompt on the cursor row.** Run `att wait "$H" --regex 'READY>$' --scope cursor-line --timeout 10000 --json`. `.result.cursorRow` is the row of the last `READY>` prompt.
- **Stable screen.** Run `att wait "$H" --screen-stable-ms 1000 --timeout 10000 --json`. `.result.matched` is `true`, and `.result.screenHash` equals the `screenHash` of a `snapshot` taken right after it.
- **Marker.** Run `att mark "$H" checkpoint --json`. `.result.seq` is a number, and `events.jsonl` of the session has a `marker` event with label `checkpoint` at that seq.
- **Time-out.** Run `att wait "$H" --text never-there --timeout 500 --json`. Exit code 11, `.error.code` is `WAIT_TIMEOUT`.
- **Key chord and exit.** Run `att send-keys "$H" Ctrl+C --json`, then `att wait "$H" --exit --timeout 10000 --json`. The screen shows `INTERRUPTED`, and `.result` is `{"timedOut":false,"exitCode":130}`.
- **Proof.** Save the final `snapshot --format text --json` of each session and a `screenshot --json` of `$B` under `$EVIDENCE/input/`, and copy `events.jsonl` of both sessions there.

## Gotchas

- A plain `/bin/bash` loads your dotfiles, and their prompt (starship, git status) changes the screen and slows each `run`. Use `--noprofile --norc` with `--env 'PS1=$ '`.
- A `wait --text` matches anywhere on the visible screen: the echo of the command you just typed, and output of an earlier step that is still on the screen. Wait for a token that only the new output contains (build it with `printf`, as in the recipe), or use `--scope cursor-line` for prompts. `--after-seq` only skips older snapshots; it does not hide older text that is still on the screen.
- `run --no-wait` returns before the shell reads the command. A second `run` sent before the first finishes is echoed at once, so the screen shows it typed ahead of the first command's output.
- Rendered lines lose trailing spaces, so the prompt `READY> ` matches `READY>$`, not `READY> $`.
- Without `NODE_OPTIONS=--disable-warning=DEP0205` (set by `env.sh`), Node 26 prints a tsx deprecation warning after the fixture's prompt, and a cursor-line wait for `READY>$` never matches.
- `hello-prompt` exits on Ctrl+C. Input after that fails with `SESSION_NOT_RUNNING` (exit 4).
- `type` and `send-keys` return once the input is written, not when the program has reacted. Always follow them with a `wait`.
