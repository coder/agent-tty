# Dashboard

A user opens `agent-tty dashboard` to watch a Home's sessions live, without sending them input. The left pane lists sessions with a status dot, the right pane shows the selected session's screen, and the footer lists the keys.

## Sub-features

- `dash-list` lists the Home's active sessions with ID, status dot and name.
- `dash-live-view` shows the selected session's current screen.
- `dash-select` moves the selection with `j`/`k` or the arrow keys.
- `dash-scope` switches between active and all sessions with `a`, or starts with `--all`.
- `dash-maximize` maximizes the live view with Enter.
- `dash-overview` switches the live view to the lossy overview with `z`.
- `dash-preselect` selects a session at launch with `--session <id>`.
- `dash-homes` opens the Home picker with `H`.
- `dash-quit` exits with `q` or Ctrl+C.

## How to get to it (user POV)

- `agent-tty dashboard` (alias `d`), with `--all` and `--session <id>`.
- Inside it: `Tab`, `↑`/`↓`, `j`/`k`, Enter, `a`, `H`, `z`, `q`, as the footer lists them.

## Driving it with att

Preconditions:

- `mkdir -p "$EVIDENCE/dashboard"` has run. The recipe saves its proof there.
- The baseline preconditions in the README hold, and the run's Home has no active session (`att list --json` shows `"sessions":[]`).
- A session to watch: `W=$(att create --json --name watched --env 'PS1=$ ' -- /bin/bash --noprofile --norc | jq -r .result.sessionId)`, then `att run "$W" 'echo watched-output-123' --json` returns `completed: true`.
- A finished session: `F=$(att create --json --name finished -- /bin/sh -c 'exit 0' | jq -r .result.sessionId)`, then `att wait "$F" --exit --timeout 10000 --json` returns `exitCode: 0`.

- **Open.** Run `D=$(att create --json --name dash --cols 120 --rows 30 -- node "$AGENT_TTY_REPO/dist/cli/main.js" dashboard | jq -r .result.sessionId)`, then `att wait "$D" --text 'q quit' --timeout 15000 --json`. The wait matches. A text snapshot shows `agent-tty dashboard  read-only`, the line `Sessions · active (2)`, and one row per session.
- **List.** In the same snapshot, the row for `W` shows its ID and the start of its name (`watc…`). The dashboard's own session `dash` is in the list too, selected first (`▸`).
- **Select and live view.** Run `att send-keys "$D" j --json`, then `att wait "$D" --text 'watched-output-123' --timeout 15000 --json`. The wait matches: the right pane now shows the screen of `W`.
- **Proof.** Run `att screenshot "$D" --json`, copy the PNG to `$EVIDENCE/dashboard/`, and look at it: the `watched` row is selected and the right pane shows `watched-output-123`.
- **Scope.** Run `att send-keys "$D" a --json`, then `att wait "$D" --text 'Sessions · all (3)' --timeout 15000 --json`. The wait matches, and the list now also has the row of `F`, with a hollow dot `○`. Press `a` again, and `att wait "$D" --text 'Sessions · active (2)' --timeout 15000 --json` matches.
- **Maximize.** Run `att send-keys "$D" Enter --json`, then `att wait "$D" --text 'esc/⏎ restore' --timeout 15000 --json`. The footer is `maximized · ↑/↓ h/j/k/l pan · z overview · esc/⏎ restore · q quit`, and a snapshot shows the screen of `W` across the full width, with no `Sessions ·` line.
- **Overview.** Run `att send-keys "$D" z --json`, then `att wait "$D" --text '[overview]' --timeout 15000 --json`. The live view header reads `screen 80×24 [overview]`. Press `z` again, and `att wait "$D" --regex 'screen 80×24 +│' --timeout 15000 --json` matches: the header is back to `screen 80×24`. Press Enter, and `att wait "$D" --text 'focus:list' --timeout 15000 --json` matches: the list is back.
- **Home picker.** Run `att send-keys "$D" H --json`, then `att wait "$D" --text 'choosing Home' --timeout 15000 --json`. The picker replaces both panes. It shows `Switch Home · active (1)`, one row for the run's Home with `◉` (the current Home) and `2 active / 3`, and the footer `↑/↓ j/k select Home · ⏎ open · a scope · esc cancel · q quit`. Press `H` again, and `att wait "$D" --text 'focus:list' --timeout 15000 --json` matches.
- **Read-only.** Run `att inspect "$W" --json` before and after the steps above. `eventCount` changes only by the events of your own `att run`, never by a dashboard key.
- **Quit.** Run `att send-keys "$D" q --json`, then `att wait "$D" --exit --timeout 15000 --json`. `.result.exitCode` is `0`.
- **Start with all sessions.** Run `D2=$(att create --json --name dash-all --cols 120 --rows 30 -- node "$AGENT_TTY_REPO/dist/cli/main.js" dashboard --all | jq -r .result.sessionId)`, then `att wait "$D2" --text 'Sessions · all (4)' --timeout 15000 --json`. The wait matches: the list has `W`, `F`, the exited `dash` session and `D2`, and the finished rows have `○`. Quit it with `q`.
- **Start on a session.** Run `D3=$(att create --json --name dash-pick --cols 120 --rows 30 -- node "$AGENT_TTY_REPO/dist/cli/main.js" dashboard --session "$W" | jq -r .result.sessionId)`, then `att wait "$D3" --text 'watched-output-123' --timeout 15000 --json`. The wait matches with no key sent: the `W` row is selected (`▸`), and the header ends in the last 9 characters of `$W` and `running`. Quit it with `q`.

## Gotchas

- Run the dashboard as the program of an agent-tty session. Run directly in a non-interactive shell, it has no TTY.
- The dashboard is in its own session list, and it starts on the first row. With it selected, the live view shows the dashboard inside itself. Select another row before you assert on the live view.
- Names are cut to fit the list column (`watched` shows as `watc…`). Assert on session IDs or on the live view, not on full names.
- "Read-only" means no input to sessions. The dashboard still reconciles sessions every 1.5 seconds through `listSessions`, so it rewrites `session.json` of a session whose host died.
- Give the dashboard session at least `--cols 120 --rows 30`. At 80x24 the list and the live view are cramped and text you wait for can be cut off.
