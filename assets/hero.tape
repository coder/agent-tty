# assets/hero.tape — generates the README hero GIF with VHS (charmbracelet/vhs).
#
# Run from the repo root:
#     vhs assets/hero.tape            # writes assets/hero.gif
#
# Prereqs (vhs 0.11.0 + ffmpeg 8.1.1 are already pinned in mise.toml):
#   - `agent-tty` on PATH  (npm i -g agent-tty, or `npm run build && npm link`)
#   - `jq`
# It uses the fast, browser-free `libghostty-vt` renderer so the GIF stays short
# (no Chromium boot). For a crisper, tighter, more "terminal" look, tune
# FontFamily (must be installed!), FontSize, LineHeight, LetterSpacing, and
# Padding below, plus the per-step Sleeps. The session is sized to 72x18 so a
# 26pt font fills the frame without the 80-col default wrapping. Regenerate,
# then replace the HERO DEMO comment block in README.md with:
#     ![agent-tty: drive a terminal session and inspect it as reviewable text](./assets/hero.gif)

Output assets/hero.gif

Require agent-tty
Require jq

Set Shell bash
# Use a font that's actually installed (VHS silently falls back to an ugly
# default otherwise). FiraCode Nerd Font Mono is on this machine and reads clean.
# Bulletproof alternatives: "Menlo", "SF Mono", "Monaco", "JetBrains Mono".
Set FontFamily "FiraCode Nerd Font Mono"
Set FontSize 26
Set Width 1280
Set Height 640
Set Padding 16                    # tighter frame (was 28)
Set LineHeight 1.0                # tight lines; nudge to ~1.15 if they touch
Set LetterSpacing 0               # no extra tracking
Set Theme "Catppuccin Mocha"      # any VHS theme works; try "Dracula", "Nord"
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0

# --- hidden setup: isolated home + fast native renderer, then a clean screen ---
Hide
Type "export AGENT_TTY_HOME=$(mktemp -d) AGENT_TTY_RENDERER=libghostty-vt" Enter
Type "clear" Enter
Show

Sleep 800ms
Type "# open a long-lived terminal session" Enter
Sleep 500ms
Type 'SID=$(agent-tty create --json --cols 72 --rows 18 -- bash | jq -r .result.sessionId)' Enter
Sleep 1200ms

Type "# run a command inside it" Enter
Sleep 500ms
Type 'agent-tty run "$SID" "echo hello from agent-tty"' Enter
Sleep 1500ms

Type "# wait for the screen — no sleeps, no grep" Enter
Sleep 500ms
Type 'agent-tty wait "$SID" --text "hello from agent-tty"' Enter
Sleep 1500ms

Type "# inspect the rendered screen as text you can diff" Enter
Sleep 500ms
Type 'agent-tty snapshot "$SID" --format text' Enter
Sleep 2800ms

Type "# screenshots, asciicasts and WebM export come from the same session" Enter
Sleep 1200ms

# --- hidden teardown ---
Hide
Type 'agent-tty destroy "$SID" >/dev/null 2>&1' Enter
Show
Sleep 500ms

# -----------------------------------------------------------------------------
# ALTERNATIVE — dogfood it: record the loop with agent-tty itself, then convert.
# Drive the same create/run/wait/snapshot sequence, then:
#     agent-tty record export "$SID" --format webm --out demo.webm
#     ffmpeg -i demo.webm -vf "fps=12,scale=1200:-1:flags=lanczos" assets/hero.gif
# This makes the hero GIF literally the tool's own output ("recorded by the tool
# it documents"), at the cost of the Chromium-backed ghostty-web render path.
