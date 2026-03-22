# LazyVim + Claude Code Extra — Dogfood Scenario

**Date:** 2026-03-22
**Environment:** Linux x86_64, Neovim 0.11.2, agent-terminal v0.1.0

## Scenario

This dogfood bundle demonstrates a full interactive LazyVim workflow driven
entirely through agent-terminal CLI commands:

1. Install Neovim 0.11.2 (AppImage extraction)
2. Clone the LazyVim starter configuration
3. First boot LazyVim — automatic plugin installation (32 plugins)
4. Navigate the LazyVim dashboard
5. Open Lazy Extras
6. Search for and enable the `ai.claudecode` extra
7. Restart to activate the new plugin (33 plugins)
8. Show `<leader>a` AI keybinding menu with Claude Code bindings

## Sessions

- **Session 1** (`01KMACYZ0DJQRR4PE45QPYG7R4`): LazyVim first boot → plugin install → dashboard → Lazy Extras → enable claudecode → quit
- **Session 2** (`01KMAD6WVQW2CCSZCDGE0HWFM5`): Restart with claudecode active → installer shows claudecode.nvim → dashboard → `<leader>a` AI keybindings

## Artifacts

### Screenshots (dark theme, reference-dark profile)

| # | File | Description |
|---|------|-------------|
| 01 | `01-lazyvim-installer.png` | LazyVim first boot: lazy.nvim installing 32 plugins |
| 02 | `02-lazyvim-dashboard.png` | LazyVim ASCII art dashboard with menu options |
| 03 | `03-lazy-extras.png` | Lazy Extras panel showing available extras |
| 04 | `04-claude-code-extra.png` | Cursor on `ai.claudecode` after `/claude` search |
| 05 | `05-claude-code-enabled.png` | Enabled Plugins (4) showing `ai.claudecode` active |
| 06 | `06-dashboard-after-extras.png` | Dashboard after closing Lazy Extras |
| 07 | `07-leader-which-key.png` | Which-key popup from `<leader>` (before claudecode) |
| 08 | `08-claudecode-installed.png` | lazy.nvim showing claudecode.nvim + all `<leader>a` keys |
| 09 | `09-leader-a-ai-keys.png` | `<leader>a` AI sub-menu with Claude Code bindings |
| 09L | `09-leader-a-ai-keys-light.png` | Same in light theme |

### Recordings

| File | Format | Description |
|------|--------|-------------|
| `session1-lazyvim-install.cast` | asciicast v2 | Full session 1 replay (install + extras + enable) |
| `session2-claudecode-keys.cast` | asciicast v2 | Full session 2 replay (restart + leader-a) |
| `session2-claudecode-keys.webm` | WebM video | Accelerated video of session 2 |

### Event logs

| File | Description |
|------|-------------|
| `session1-events.jsonl` | Raw event log from session 1 |
| `session2-events.jsonl` | Raw event log from session 2 |

## Verification claims

1. **LazyVim installs successfully** — 32 plugins installed on first boot, all marked "already up to date"
2. **Dashboard renders correctly** — ASCII art logo, all menu items visible
3. **Lazy Extras works** — Full list of extras with enable/disable toggle
4. **Claude Code extra enables** — Moved from Plugins (52) → Enabled Plugins (4)
5. **Plugin activates on restart** — claudecode.nvim appears in installer with keybindings
6. **`<leader>a` menu present** — Shows: Accept diff, Add buffer, Toggle/Continue/Focus/Resume Claude, Deny diff
7. **Asciicast exports are valid** — Session 1: 2.0 MB, Session 2: 481 KB
8. **WebM export works** — Session 2: 512 KB accelerated video

## Commands used

All commands were driven via `agent-terminal` CLI:
- `create --cols 120 --rows 40 -- nvim`
- `wait --screen-stable-ms <ms>`
- `snapshot --format text`
- `screenshot` / `screenshot --profile reference-light`
- `send-keys` (q, x, z, z, g, g, Space, a, Escape, Enter)
- `type` ("/claude", ":qa!")
- `record export --format asciicast`
- `record export --format webm`
- `destroy --force`
