# Agent-Terminal Capabilities Playbook: LazyVim + Claude Code Extra

> **Purpose:** Step-by-step runbook for a coding agent to reproduce the LazyVim
> dogfood scenario and demonstrate the full capabilities of `agent-terminal`.
>
> **Audience:** Coding agents (Claude, Copilot, etc.) running in automated
> environments with shell access.
>
> **What this proves:** An agent can install, configure, and interact with a
> complex TUI application (LazyVim/Neovim) using only CLI commands — no manual
> terminal interaction, no GUI, no screen sharing.

---

## Prerequisites

### System requirements

- Linux x86_64 (tested on Ubuntu/Debian)
- Node.js ≥ 24 (or use `mise` — see below)
- `git`, `curl`, `python3` on `$PATH`
- `ripgrep` (`rg`) and `fd-find` (`fdfind`) for LazyVim features
- Neovim ≥ 0.11.2 (installed in Step 1 below)
- Chromium for Playwright (for screenshot and WebM export)

### Repository setup

```bash
# Clone the repo (or you're already in it)
cd /path/to/agent-terminal

# Trust mise and install tooling
export PATH="$HOME/.local/bin:$PATH"
mise trust
mise install

# Install dependencies
eval "$(mise activate bash)"
npm ci

# Install Playwright Chromium (required for screenshot + WebM)
npx playwright install chromium

# Verify Chromium installed successfully
npx playwright install chromium
npx tsx src/cli/main.ts doctor --json 2>&1 \
  | python3 -c "import sys,json; d=json.load(sys.stdin); checks={c['name']:c['status'] for c in d['result']['checks']}; assert checks.get('browser-launch')=='pass', 'Chromium not available'" \
  || { echo "FAIL: Chromium/Playwright not working — screenshot and WebM export will fail"; exit 1; }
```

### Verify the CLI works

```bash
npx tsx src/cli/main.ts version --json
npx tsx src/cli/main.ts doctor --json
```

Both should return `"ok": true`. The doctor output should show all checks
passing including `pty-spawn`, `home-writable`, and renderer checks.

---

## Step 0: Environment isolation

**Every run should use an isolated `AGENT_TERMINAL_HOME`** to avoid polluting
the real session store or interfering with other runs.

```bash
export AGENT_TERMINAL_HOME=$(mktemp -d)
echo "Using agent-terminal home: $AGENT_TERMINAL_HOME"
```

Create a bundle directory to collect all artifacts:

```bash
BUNDLE="dogfood/$(date +%Y%m%d)-lazyvim-scenario"
mkdir -p "$BUNDLE/artifacts"
echo "$AGENT_TERMINAL_HOME" > "$BUNDLE/agent-terminal-home.txt"
```

**Shorthand for the CLI** used throughout this playbook:

```bash
CLI="npx tsx src/cli/main.ts"
```

---

## Step 1: Install Neovim ≥ 0.11.2

LazyVim requires Neovim ≥ 0.11.2. The system `nvim` is often too old.

```bash
# Download and extract the Neovim AppImage
cd /tmp
curl -sLO https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.appimage
chmod +x nvim-linux-x86_64.appimage
./nvim-linux-x86_64.appimage --appimage-extract 2>/dev/null
NVIM_DIR="$HOME/.local/nvim-latest"
rm -rf "$NVIM_DIR"
mv squashfs-root "$NVIM_DIR"
rm -f nvim-linux-x86_64.appimage
cd -

# Set the path
NVIM_PATH="$NVIM_DIR/usr/bin/nvim"
export PATH="$NVIM_DIR/usr/bin:$PATH"

# Verify
$NVIM_PATH --version | head -1
# Expected: NVIM v0.11.x or newer
```

### Install LazyVim prerequisites

```bash
# ripgrep and fd are used by LazyVim's telescope/snacks pickers
which rg    || sudo apt-get install -y ripgrep
which fdfind || sudo apt-get install -y fd-find
```

---

## Step 2: Clone the LazyVim starter

```bash
# Back up any existing nvim config
mv ~/.config/nvim ~/.config/nvim.bak 2>/dev/null || true
mv ~/.local/share/nvim ~/.local/share/nvim.bak 2>/dev/null || true
mv ~/.local/state/nvim ~/.local/state/nvim.bak 2>/dev/null || true
mv ~/.cache/nvim ~/.cache/nvim.bak 2>/dev/null || true

# Clone the official LazyVim starter
git clone https://github.com/LazyVim/starter ~/.config/nvim
rm -rf ~/.config/nvim/.git

# Verify
ls ~/.config/nvim/init.lua
```

> **Note:** LazyVim's starter repository evolves over time. Plugin counts,
> extra names, and UI details may differ from this playbook. The core workflow
> (install → extras → enable → restart → verify keybindings) remains the same.

---

## Step 3: First boot — LazyVim plugin installation

This is the first `agent-terminal` interaction. We create a session running
`nvim`, which triggers LazyVim's first-boot plugin installation.

> **Note:** All steps below use `$CLI`, `$BUNDLE`, and `$AGENT_TERMINAL_HOME`
> variables defined in Step 0. Ensure they are still set in your shell.

```bash
# Create a session with generous dimensions for the TUI
RESULT=$($CLI create --cols 120 --rows 40 --json -- "$NVIM_PATH")
SID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sessionId'])") \
  || { echo "FAIL: Could not parse session ID"; exit 1; }
echo "Session 1: $SID"
echo "$RESULT" > "$BUNDLE/create-session1.json"
```

### Wait for plugin installation to complete

LazyVim's first boot downloads and installs all plugins. This can take
30–120 seconds. Wait for the screen to stabilize:

```bash
$CLI wait "$SID" --screen-stable-ms 12000 --timeout 300000 --json
```

> **Key concept: `--screen-stable-ms`** waits until the terminal screen
> content hasn't changed for the given duration. This is the primary
> mechanism for waiting on TUI state transitions. Use longer values
> (8000–15000ms) for operations that involve network downloads.

### Verify: Check what's on screen

```bash
$CLI snapshot "$SID" --format text --json \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['text'])"
```

**Expected:** You should see the lazy.nvim installer UI with a list of
installed plugins (30+ plugins) and status lines showing "already up to date".

### Screenshot: LazyVim installer

```bash
RESULT=$($CLI screenshot "$SID" --json)
echo "$RESULT" > "$BUNDLE/01-installer.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/01-lazyvim-installer.png"
```

---

## Step 4: Navigate to the LazyVim dashboard

Dismiss the installer by pressing `q`:

```bash
$CLI send-keys "$SID" q
sleep 2
$CLI wait "$SID" --screen-stable-ms 3000 --timeout 30000 --json
```

### Verify: Dashboard visible

```bash
$CLI snapshot "$SID" --format text --json \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['text'])"
```

**Expected:** The classic LazyVim ASCII art logo ("LAZYVIM") with menu items:
Find File (f), New File (n), Projects (p), Find Text (g), Recent Files (r),
Config (c), Restore Session (s), Lazy Extras (x), Lazy (l), Quit (q).

### Screenshot: Dashboard

```bash
RESULT=$($CLI screenshot "$SID" --json)
echo "$RESULT" > "$BUNDLE/02-dashboard.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/02-lazyvim-dashboard.png"
```

---

## Step 5: Open Lazy Extras

Press `x` on the dashboard to open the Lazy Extras panel:

```bash
$CLI send-keys "$SID" x
sleep 2
$CLI wait "$SID" --screen-stable-ms 3000 --timeout 30000 --json
```

### Screenshot: Lazy Extras panel

```bash
RESULT=$($CLI screenshot "$SID" --json)
echo "$RESULT" > "$BUNDLE/03-extras.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/03-lazy-extras.png"
```

---

## Step 6: Find and enable the Claude Code extra

### Search for "claude"

Use Neovim's search (`/`) to jump to the `ai.claudecode` entry:

```bash
$CLI type "$SID" "/claude"
sleep 0.5
$CLI send-keys "$SID" Enter
sleep 1
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 15000 --json
```

> **Key concept: `type` vs `send-keys`**
>
> - `type` sends text as if typed on a keyboard — use for arbitrary strings,
>   search queries, command-line input.
> - `send-keys` sends named key sequences — use for special keys like
>   `Enter`, `Escape`, `Space`, `Tab`, arrow keys, and single characters
>   when you need precise key-by-key control.

### Center the cursor on the match

```bash
$CLI send-keys "$SID" z z  # zz = center cursor line on screen (two 'z' keypresses in Neovim)
sleep 1
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 10000 --json
```

### Screenshot: Claude Code extra highlighted

```bash
RESULT=$($CLI screenshot "$SID" --json)
echo "$RESULT" > "$BUNDLE/04-claude-code-extra.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/04-claude-code-extra.png"
```

### Enable the extra

Press `x` to toggle the `ai.claudecode` extra on:

```bash
$CLI send-keys "$SID" x
sleep 2
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 15000 --json
```

### Verify: Scroll to top and check "Enabled Plugins"

```bash
$CLI send-keys "$SID" g g  # gg = go to first line (two 'g' keypresses in Neovim)
sleep 1
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 10000 --json

# Verify via text snapshot
$CLI snapshot "$SID" --format text --json \
  | python3 -c "import sys,json; t=json.load(sys.stdin)['result']['text']; print('ai.claudecode' in t and 'Enabled Plugins' in t)"
# Expected: True
```

### Screenshot: Claude Code now in Enabled Plugins

```bash
RESULT=$($CLI screenshot "$SID" --json)
echo "$RESULT" > "$BUNDLE/05-claude-code-enabled.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/05-claude-code-enabled.png"
```

---

## Step 7: Close extras and quit to restart

The claudecode.nvim plugin will be downloaded on next startup.

```bash
# Close extras
$CLI send-keys "$SID" q
sleep 2
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 15000 --json

# Screenshot: Back to dashboard
RESULT=$($CLI screenshot "$SID" --json)
echo "$RESULT" > "$BUNDLE/06-dashboard-after-extras.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/06-dashboard-after-extras.png"

# Quit nvim to trigger restart
$CLI type "$SID" ":qa!"
$CLI send-keys "$SID" Enter
sleep 2

# Wait for nvim to fully exit before exporting
$CLI wait "$SID" --exit --timeout 30000 --json
```

### Export recordings from session 1 (before it's gone)

```bash
# Asciicast — captures the full installation flow
RESULT=$($CLI record export "$SID" --format asciicast --json)
echo "$RESULT" > "$BUNDLE/export-asciicast-session1.json"
CAST_PATH=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$CAST_PATH" "$BUNDLE/artifacts/session1-lazyvim-install.cast"

# Copy event log for reproducibility
EVENTS="$AGENT_TERMINAL_HOME/sessions/$SID/events.jsonl"
cp "$EVENTS" "$BUNDLE/session1-events.jsonl" 2>/dev/null || true
```

---

## Step 8: Restart with Claude Code active

Create a new session — LazyVim will now install `claudecode.nvim`:

```bash
RESULT=$($CLI create --cols 120 --rows 40 --json -- "$NVIM_PATH")
SID2=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sessionId'])")
echo "Session 2: $SID2"
echo "$RESULT" > "$BUNDLE/create-session2.json"

# Wait for plugin installation (installs claudecode.nvim)
$CLI wait "$SID2" --screen-stable-ms 10000 --timeout 180000 --json
```

### Verify: claudecode.nvim appears in plugin list

```bash
$CLI snapshot "$SID2" --format text --json \
  | python3 -c "import sys,json; t=json.load(sys.stdin)['result']['text']; print('claudecode.nvim' in t)" \
  || { echo "FAIL: Could not verify claudecode"; exit 1; }
# Expected: True
```

### Screenshot: claudecode.nvim installed

```bash
RESULT=$($CLI screenshot "$SID2" --json)
echo "$RESULT" > "$BUNDLE/08-claudecode-installed.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/08-claudecode-installed.png"
```

---

## Step 9: Show `<leader>a` AI keybindings

First dismiss the installer and open a buffer:

```bash
# Close installer
$CLI send-keys "$SID2" q
sleep 2
$CLI wait "$SID2" --screen-stable-ms 2000 --timeout 15000 --json

# Open a new file (gets us out of the dashboard into a normal buffer)
$CLI send-keys "$SID2" n
sleep 1
$CLI send-keys "$SID2" Escape
sleep 0.5
```

### Open the which-key leader menu

LazyVim's default leader key is `Space`:

```bash
$CLI send-keys "$SID2" Space
sleep 2
$CLI wait "$SID2" --screen-stable-ms 2000 --timeout 10000 --json
```

### Screenshot: Which-key leader menu (before selecting AI)

This captures the which-key popup showing the new `a → +ai` entry:

```bash
RESULT=$($CLI screenshot "$SID2" --json)
echo "$RESULT" > "$BUNDLE/07-leader-which-key.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/07-leader-which-key.png"
```

### Verify: `a` → `+ai` appears in which-key

```bash
$CLI snapshot "$SID2" --format text --json \
  | python3 -c "import sys,json; t=json.load(sys.stdin)['result']['text']; print('+ai' in t)"
# Expected: True
```

### Press `a` to open the AI sub-menu

```bash
$CLI send-keys "$SID2" a
sleep 2
$CLI wait "$SID2" --screen-stable-ms 2000 --timeout 10000 --json
```

### Verify: Claude Code keybindings visible

```bash
TEXT=$($CLI snapshot "$SID2" --format text --json \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['text'])")
echo "$TEXT"
# Expected to contain:
#   Accept diff
#   Add current buffer
#   Toggle Claude
#   Continue Claude
#   Deny diff
#   Focus Claude
#   Resume Claude
```

### Screenshot: `<leader>a` AI keybinding menu (dark + light)

```bash
RESULT=$($CLI screenshot "$SID2" --json)
echo "$RESULT" > "$BUNDLE/09-leader-a-ai-keys.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/09-leader-a-ai-keys.png"

RESULT=$($CLI screenshot "$SID2" --profile reference-light --json)
echo "$RESULT" > "$BUNDLE/09-leader-a-ai-keys-light.json"
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/09-leader-a-ai-keys-light.png"
```

---

## Step 10: Export recordings and video

### Asciicast from session 2

```bash
RESULT=$($CLI record export "$SID2" --format asciicast --json)
echo "$RESULT" > "$BUNDLE/export-asciicast-session2.json"
CAST_PATH=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$CAST_PATH" "$BUNDLE/artifacts/session2-claudecode-keys.cast"
```

### WebM video from session 2

```bash
RESULT=$($CLI record export "$SID2" --format webm --json)
echo "$RESULT" > "$BUNDLE/export-webm-session2.json"
WEBM_PATH=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$WEBM_PATH" "$BUNDLE/artifacts/session2-claudecode-keys.webm"
```

### Copy event logs

```bash
EVENTS2="$AGENT_TERMINAL_HOME/sessions/$SID2/events.jsonl"
cp "$EVENTS2" "$BUNDLE/session2-events.jsonl" 2>/dev/null || true
```

---

## Step 11: Cleanup

```bash
# Destroy session 2
$CLI destroy "$SID2" --force 2>/dev/null || true

# Run gc to clean up
$CLI gc --json

# List final bundle contents
echo "=== Bundle contents ==="
find "$BUNDLE" -type f | sort
```

---

## Agent-Terminal Command Reference

This section summarizes the key commands and patterns used in this playbook.

### Session lifecycle

| Command   | Purpose                       | Example                               |
| --------- | ----------------------------- | ------------------------------------- |
| `create`  | Start a new terminal session  | `create --cols 120 --rows 40 -- nvim` |
| `inspect` | Check session status/metadata | `inspect <SID> --json`                |
| `destroy` | Stop a session                | `destroy <SID> --force`               |
| `list`    | List all sessions             | `list --all --json`                   |
| `gc`      | Clean up exited sessions      | `gc --dry-run --json`                 |

### Input

| Command     | Purpose                     | When to use                                             |
| ----------- | --------------------------- | ------------------------------------------------------- |
| `type`      | Send text as keystrokes     | Search queries, command-line input, arbitrary text      |
| `send-keys` | Send named key sequences    | `Enter`, `Escape`, `Space`, `Tab`, single chars, combos |
| `paste`     | Send text via paste bracket | Large text blocks, code snippets                        |

### Observation

| Command      | Purpose                        | Key options                                                                    |
| ------------ | ------------------------------ | ------------------------------------------------------------------------------ |
| `snapshot`   | Read terminal text content     | `--format text` (plain text) or `--format structured` (JSON with per-row data) |
| `screenshot` | Render terminal as PNG image   | `--profile reference-dark` (default) or `--profile reference-light`            |
| `wait`       | Block until a condition is met | See "Wait strategies" below                                                    |

### Wait strategies

| Strategy      | Flag                      | When to use                                       |
| ------------- | ------------------------- | ------------------------------------------------- |
| Screen stable | `--screen-stable-ms 3000` | TUI transitions, plugin installs, loading screens |
| Text match    | `--text "Ready"`          | Wait for specific text to appear                  |
| Regex match   | `--regex "\\d+ plugins"`  | Wait for pattern-based content                    |
| Process exit  | `--exit`                  | Wait for the process to terminate                 |
| Output idle   | `--idle-ms 500`           | Wait for output to stop (non-renderer)            |

> **Choosing the right wait:**
>
> - For TUI apps (nvim, htop, etc.): use `--screen-stable-ms` with a generous
>   value (3000–15000ms depending on expected activity).
> - For CLI tools that print output: use `--text` or `--regex` to match the
>   expected final output.
> - For builds or long-running processes: use `--exit` with a long `--timeout`.

### Export

| Command         | Purpose                      | Key options                                                   |
| --------------- | ---------------------------- | ------------------------------------------------------------- |
| `record export` | Export session recording     | `--format asciicast` (text replay) or `--format webm` (video) |
| `doctor`        | Health check the environment | Verify renderer, PTY, filesystem health                       |

### Post-exit operations

**Snapshots and screenshots work on exited sessions** via offline replay.
After a session exits (or is destroyed), you can still:

```bash
$CLI snapshot "$SID" --format text --json    # Works after exit
$CLI screenshot "$SID" --json                # Works after exit
$CLI record export "$SID" --format asciicast --json  # Works after exit
$CLI record export "$SID" --format webm --json       # Works after exit
```

This is powered by the persisted event log (`events.jsonl`) — the CLI boots
a fresh renderer, replays all events, and captures the final state.

---

## Common Patterns for Agents

### Pattern: Wait-then-verify

Always pair waits with verification snapshots:

```bash
# Wait for state transition
$CLI wait "$SID" --screen-stable-ms 3000 --timeout 30000 --json

# Verify expected content
TEXT=$($CLI snapshot "$SID" --format text --json \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['text'])")

# Assert expected content is present
echo "$TEXT" | grep -q "expected content" || echo "FAIL: expected content not found"
```

### Pattern: Navigate a TUI menu

```bash
# Open menu
$CLI send-keys "$SID" Space   # or whatever key opens the menu
sleep 1
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 10000 --json

# Select item
$CLI send-keys "$SID" a       # key for the menu item
sleep 1
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 10000 --json
```

### Pattern: Search in Neovim

```bash
$CLI type "$SID" "/search-term"
sleep 0.5
$CLI send-keys "$SID" Enter
sleep 1
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 10000 --json
```

### Pattern: Execute a Neovim command

```bash
$CLI type "$SID" ":command args"
$CLI send-keys "$SID" Enter
sleep 1
$CLI wait "$SID" --screen-stable-ms 2000 --timeout 10000 --json
```

### Pattern: Screenshot + verify visually

```bash
RESULT=$($CLI screenshot "$SID" --json)
ARTIFACT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['artifactPath'])")
cp "$ARTIFACT" "$BUNDLE/artifacts/step-name.png"
# Use attach_file tool to visually inspect the screenshot if available
```

### Pattern: Multi-session workflow (requires restart)

Some plugins (like LazyVim extras) only activate after a restart:

```bash
# Session 1: configure
$CLI type "$SID" ":qa!"
$CLI send-keys "$SID" Enter
sleep 2

# Export from session 1 before moving on
$CLI record export "$SID" --format asciicast --json

# Session 2: use the new configuration
RESULT=$($CLI create --cols 120 --rows 40 --json -- "$NVIM_PATH")
SID2=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sessionId'])")
$CLI wait "$SID2" --screen-stable-ms 10000 --timeout 180000 --json
```

---

## Troubleshooting

### LazyVim requires Neovim >= X.Y.Z

LazyVim's minimum version requirement changes frequently. If you see this
error, download a newer Neovim AppImage:

```bash
curl -sLO https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.appimage
```

### Screen doesn't stabilize (timeout)

Increase `--screen-stable-ms` and `--timeout`. Some operations (first plugin
install, TreeSitter parser compilation) can take minutes:

```bash
$CLI wait "$SID" --screen-stable-ms 15000 --timeout 300000 --json
```

### Sleep values may need adjustment

The `sleep` commands between key presses and waits are conservative estimates.
On very slow systems or under heavy load, you may need to increase them.
The `wait --screen-stable-ms` commands are the actual synchronization mechanism;
the sleeps just give the TUI time to process input before the wait begins.

### Screenshot is blank or shows wrong content

The renderer needs events to replay. If the screenshot is blank, the session
may not have produced any output yet. Use `snapshot --format text` to check
what text is currently visible.

### WebM export is slow

WebM export boots a Chromium browser and replays all events with timing.
For sessions with many events (1000+), this can take 30–60 seconds. The
asciicast export is nearly instant since it's purely text-based.

### send-keys vs type for special characters

- Use `send-keys` for: `Enter`, `Escape`, `Space`, `Tab`, `Backspace`,
  function keys, single letter presses in normal mode
- Use `type` for: search strings, command-line text, any multi-character input
- Rule of thumb: if it's a "word" or "sentence", use `type`. If it's a
  "button press", use `send-keys`.

---

## Expected Artifacts

A complete run of this playbook produces:

| Artifact                      | Type                 | Approx. size |
| ----------------------------- | -------------------- | ------------ |
| 01-lazyvim-installer.png      | Screenshot           | 100-130 KB   |
| 02-lazyvim-dashboard.png      | Screenshot           | 20-25 KB     |
| 03-lazy-extras.png            | Screenshot           | 90-100 KB    |
| 04-claude-code-extra.png      | Screenshot           | 100-120 KB   |
| 05-claude-code-enabled.png    | Screenshot           | 90-100 KB    |
| 06-dashboard-after-extras.png | Screenshot           | 20-25 KB     |
| 07-leader-which-key.png       | Screenshot           | 20-25 KB     |
| 08-claudecode-installed.png   | Screenshot           | 80-90 KB     |
| 09-leader-a-ai-keys.png       | Screenshot (dark)    | 20-25 KB     |
| 09-leader-a-ai-keys-light.png | Screenshot (light)   | 20-25 KB     |
| session1-lazyvim-install.cast | asciicast v2         | 1.5-2.5 MB   |
| session2-claudecode-keys.cast | asciicast v2         | 400-600 KB   |
| session2-claudecode-keys.webm | WebM video           | 400-600 KB   |
| session1-events.jsonl         | Event log            | 1.5-2.5 MB   |
| session2-events.jsonl         | Event log            | 400-600 KB   |
| \*.json                       | CLI output envelopes | <1 KB each   |

---

## Verification checklist

After completing all steps, verify:

- [ ] LazyVim installer showed 30+ plugins installed
- [ ] Dashboard rendered with ASCII art logo and all menu items
- [ ] Lazy Extras panel opened and listed available extras
- [ ] `ai.claudecode` was found via search and enabled
- [ ] After restart, `claudecode.nvim` appears in installed plugins (33 total)
- [ ] `<leader>a` opens an AI sub-menu with Claude Code bindings
- [ ] At least these keybindings are visible: Accept diff, Toggle Claude, Focus Claude, Resume Claude
- [ ] Asciicast files are non-empty and valid (first line is JSON with `"version": 2`)
- [ ] WebM file is non-empty and starts with the WebM magic bytes (`\x1a\x45\xdf\xa3`)
- [ ] All screenshots are non-empty PNGs (> 10 KB)
