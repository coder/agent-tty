# assets/hero.tape — generates the README hero GIF with VHS (charmbracelet/vhs).
#
# Regenerate (from the repo root):
#     mise run demo:hero             # builds the dev CLI, then runs this tape
#
# That task `depends` on `build` and puts vhs/ffmpeg/tmux/jq on PATH. To run the
# tape directly instead, build first and provide those tools yourself:
#     npm run build && vhs assets/hero.tape
#
# Why build first: this hero shows `agent-tty dashboard`, which is unreleased —
# a globally-installed `agent-tty` (e.g. `npm i -g agent-tty`) won't have it. So
# the hidden setup below points PATH at THIS checkout's freshly-built CLI
# (dist/cli/main.js) instead of `Require agent-tty`. It also needs the
# dashboard's optional renderer `@coder/libghostty-vt-node` (a normal `npm i`
# fetches it; check with `agent-tty doctor`).
#
# Prereqs (jq + tmux are pinned in mise's [tools]; tmux >= 3.1 for `-l 50%`):
#   - `npm run build` has been run in this checkout
#   - `jq`, `tmux`
#   - `ttyd` (VHS needs it): mise installs it on Linux, but it has no macOS
#     binary — on macOS run `brew install ttyd` yourself (mise finds it on PATH).
#
# Structure: the hidden setup builds a clean tmux split (left = operator shell,
# right = idle shell). The panes and the agent-tty session all run `bash --norc`
# (with a minimal `$ ` prompt on the panes via PS1) so they — and the dashboard's
# live mirror — stay free of personal prompt clutter; `--norc` is what keeps the
# user's interactive shell config (e.g. zsh `%{…%}` prompt escapes) out of the
# frame. The visible recording then *types* `agent-tty dashboard` into the right
# pane (so viewers see how it's launched), hops back to the left with the tmux
# prefix, and drives a session whose changes the dashboard mirrors live.
# AGENT_TTY_HOME is exported before tmux so the server and both panes share it.
# (For a minimal `$ ` prompt in the mirror too, add `--env 'PS1=$ '` to create.)
#
# TUNING (do a visual pass after regenerating): Width/Height/FontSize and the
# split percentage (`-l 50%`) trade off readability of the two panes. The split
# is 50/50; FontSize is 18 so the longest CLI lines fit one un-split half — bump
# the font only if you also widen the frame, or the operator-pane lines wrap.
# The session defaults to 80x24, a touch wider than the half-width dashboard
# pane, so its mirror clips to the top-left (where the `echo` output lands); add
# `--cols/--rows` to `create` for a tighter, fully-visible mirror. FontFamily fallbacks if FiraCode
# isn't installed: "Menlo", "SF Mono", "JetBrains Mono". Keep the README hero
# pointing at ./assets/hero.gif:
#     ![agent-tty: drive a terminal session and watch it live in the dashboard](./assets/hero.gif)

Output assets/hero.gif

Require jq
Require tmux

Set Shell bash
# Use a font that's actually installed (VHS silently falls back to an ugly
# default otherwise). FiraCode Nerd Font Mono is on this machine and reads clean.
Set FontFamily "FiraCode Nerd Font Mono"
# 18pt (not 20) so each half of the 50/50 split is wide enough for the longest
# CLI lines (the `create … | jq` and `run --no-wait …` lines) without wrapping.
Set FontSize 18
Set Width 1920
Set Height 720
Set Padding 16
Set LineHeight 1.0
Set LetterSpacing 0
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0

# --- hidden setup: dev CLI on PATH + a clean tmux split (operator | idle) ---
# AGENT_TTY_HOME, PATH, and PS1 are exported BEFORE tmux so the server and both
# `bash --norc` panes inherit them. The split runs idle shells; the dashboard is
# launched visibly below. kill-server first makes regeneration idempotent.
Hide
Type "export AGENT_TTY_HOME=$(mktemp -d) AGENT_TTY_RENDERER=libghostty-vt" Enter
Type "export HERO_BIN=$(mktemp -d)" Enter
Type 'chmod +x dist/cli/main.js && ln -sf "$PWD/dist/cli/main.js" "$HERO_BIN/agent-tty"' Enter
Type 'export PATH="$HERO_BIN:$PATH"' Enter
Type "export PS1='$ '" Enter
Type "tmux -L hero kill-server 2>/dev/null; true" Enter
Type "tmux -f /dev/null -L hero new-session -d -s hero 'bash --norc' \; set -g status off \; split-window -h -l 50% -t hero 'bash --norc' \; select-pane -t hero.0 \; attach -t hero" Enter
Show

Sleep 1000ms
Type "# drive a real terminal session with plain CLI calls" Enter
Sleep 500ms
Type 'SID=$(agent-tty create --json -- bash --norc | jq -r .result.sessionId)' Enter
Sleep 1200ms

Type "# open the dashboard on the right to watch it live →" Enter
Sleep 600ms
# hop to the right pane with the tmux prefix (Ctrl+B then o = next pane)
Ctrl+B
Type "o"
Sleep 500ms
Type "agent-tty dashboard --all" Enter
Sleep 2200ms
# hop back to the left pane to keep driving the session
Ctrl+B
Type "o"
Sleep 600ms

Type "# run a command inside it — watch the dashboard mirror it live →" Enter
Sleep 500ms
Type 'agent-tty run "$SID" "echo hello from agent-tty"' Enter
Sleep 2200ms

Type "# fire a slow command, then wait for its OUTPUT — no sleeps, no polling →" Enter
Sleep 500ms
# Two things make the wait meaningful here:
#  1. $RANDOM is single-quoted so the SESSION expands it — the echoed command
#     line shows the literal "$RANDOM", not a number.
#  2. We therefore wait on a DIGIT after the colon (--regex), NOT the phrase
#     "your random number is:". That phrase is already on screen from the echoed
#     command, so a --text wait would match instantly and prove nothing; the
#     digits only appear once the command actually prints, after the 6s sleep.
Type "agent-tty run --no-wait $SID 'sleep 6; echo your random number is: $RANDOM'" Enter
# `wait` is typed right after the fire (no comment between) so the bulk of the 6s
# sleep elapses WHILE wait blocks — the deterministic wait is visible on camera.
Sleep 400ms
Type 'agent-tty wait "$SID" --regex "random number is: [0-9]+"' Enter
Sleep 5000ms

Type "# and snapshot the result as text you can diff" Enter
Sleep 500ms
Type 'agent-tty snapshot "$SID" --format text' Enter
Sleep 2800ms

# --- hidden teardown: stays hidden to the end, so the GIF's last frame is the
# split — NOT the bare outer shell that `kill-server` drops back to (a trailing
# `Show` here flashes that shell + a "[server exited]" line, which looks ugly) ---
Hide
Type 'agent-tty destroy "$SID" >/dev/null 2>&1' Enter
Type "tmux -L hero kill-server" Enter
# kill-server returns to the outer shell, which still holds these vars; clean up
# the temp home + bin so repeated local runs don't litter $TMPDIR.
Type 'rm -rf "$AGENT_TTY_HOME" "$HERO_BIN"' Enter
# Hidden settle time so the cleanup completes before the tape ends (no Show).
Sleep 1s
