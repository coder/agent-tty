# Nvim Dogfood Demo — agent-terminal Week 1

- **Date:** 2026-03-19
- **Scenario:** Driving `neovim` entirely through the `agent-terminal` CLI
- **Session ID:** `01KM3NDZK4TXG5C3SQJ811ZGVJ`
- **Command:** `nvim .`
- **Dimensions:** `100x30`
- **Created:** `2026-03-19T18:23:54.983Z`
- **Exited:** `2026-03-19T18:25:58.079Z`
- **Exit code:** `0`
- **Overall result:** pass

## Scenario summary

This proof bundle demonstrates that the Week 1 control plane can drive a complex, modal, full-screen terminal application rather than only narrow fixture programs. In this run, `agent-terminal` launched `neovim`, opened a new buffer, named it, entered insert mode, typed multi-line Markdown content, saved the file, navigated with a real Vim motion (`gg`), and exited cleanly.

That combination matters because `nvim` exercises several properties at once: full-screen terminal rendering, modal input handling, command-line mode, text insertion, file saving, cursor movement, and orderly process exit. The run therefore acts as a stronger dogfood demo than a simple line-oriented prompt loop.

## Session metadata

| Field       | Value                        |
| ----------- | ---------------------------- |
| Session ID  | `01KM3NDZK4TXG5C3SQJ811ZGVJ` |
| Command     | `nvim .`                     |
| Dimensions  | `100 cols x 30 rows`         |
| Created     | `2026-03-19T18:23:54.983Z`   |
| Exited      | `2026-03-19T18:25:58.079Z`   |
| Exit status | `exited`                     |
| Exit code   | `0`                          |

`inspect-final.json` is the final machine-readable confirmation that the session exited normally with code `0`.

## Step-by-step walkthrough

| Step | CLI action                                                                           | What it did                                                              | Expected evidence                                                                                                    |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1    | `create --cols 100 --rows 30 -- nvim .`                                              | Started a new session and launched `nvim` against the current directory. | `01-nvim-launched.txt` should show the initial netrw directory listing inside Neovim.                                |
| 2    | `send-keys Escape`                                                                   | Forced normal mode before issuing editor commands.                       | The session remains in Neovim and is ready for command-mode input.                                                   |
| 3    | `type ":enew"` + `send-keys Enter`                                                   | Created a fresh empty buffer.                                            | `02-new-buffer.txt` should show an empty buffer named `dogfood`.                                                     |
| 4    | `type ":file dogfood"` + `send-keys Enter`                                           | Assigned the new buffer an initial name.                                 | The buffer name changes to `dogfood`, but this later proves ambiguous because a `dogfood/` directory already exists. |
| 5    | `send-keys i`                                                                        | Entered INSERT mode.                                                     | Neovim is ready to accept literal text input.                                                                        |
| 6    | `type "# Dogfood Demo"` + `send-keys Enter`                                          | Wrote the Markdown heading.                                              | The first line of the document is populated.                                                                         |
| 7    | `type "This file was created by agent-terminal driving neovim."` + `send-keys Enter` | Added the first explanatory sentence.                                    | The second line appears beneath the heading.                                                                         |
| 8    | `type "All keystrokes were sent via the agent-terminal CLI."` + `send-keys Enter`    | Added the second explanatory sentence.                                   | The third line appears in the buffer.                                                                                |
| 9    | `type "Session ID: 01KM3NDZK4TXG5C3SQJ811ZGVJ"`                                      | Added the run-specific session identifier to the file contents.          | The fourth content line includes the exact session ID used for the demo.                                             |
| 10   | `send-keys Escape`                                                                   | Returned to normal mode.                                                 | Insert mode ends so Ex commands can be issued again.                                                                 |
| 11   | `type ":file dogfood.md"` + `send-keys Enter`                                        | Renamed the buffer to `dogfood.md`.                                      | This is the real-world correction after discovering that `dogfood` conflicts with an existing directory name.        |
| 12   | `type ":w"` + `send-keys Enter`                                                      | Saved the file to disk.                                                  | `04-file-saved.txt` should show the successful write message: `"dogfood.md" [New] 6L, 165B written`.                 |
| 13   | `send-keys g` + `send-keys g`                                                        | Executed the Vim motion `gg` to jump to the top of the file.             | `05-gg-top.txt` should show the cursor positioned back at line 1.                                                    |
| 14   | `type ":q"` + `send-keys Enter`                                                      | Quit Neovim.                                                             | `06-nvim-quit.txt` should show the post-exit terminal state.                                                         |
| 15   | `wait --exit`                                                                        | Waited for process termination.                                          | The session exits cleanly without timing out.                                                                        |
| 16   | `inspect`                                                                            | Collected final session state.                                           | `inspect-final.json` should report `status: "exited"` and `exitCode: 0`.                                             |

## Screenshot review guide

The screenshot artifacts for this bundle are text snapshots captured from the event log rather than renderer-produced terminal frames.

| File                               | What the reviewer should observe                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `screenshots/01-nvim-launched.txt` | Neovim has launched successfully and is showing the netrw directory browser for the current working directory. |
| `screenshots/02-new-buffer.txt`    | An empty buffer is open after `:enew`, with the provisional name `dogfood`.                                    |
| `screenshots/03-content-typed.txt` | The Markdown content has been typed into the buffer while in INSERT mode.                                      |
| `screenshots/04-file-saved.txt`    | The status area confirms the save succeeded as `dogfood.md` with `6L, 165B written`.                           |
| `screenshots/05-gg-top.txt`        | The `gg` motion has moved the cursor to the top of the file.                                                   |
| `screenshots/06-nvim-quit.txt`     | Neovim has exited, demonstrating clean control handoff back to the terminal session.                           |

## Event log observations

- `event-log.jsonl` contains **65 events** for this run.
- The log spans the important interaction categories for an editor demo: terminal `output`, typed text via `input_text`, individual keypresses via `input_keys`, and the final `exit` record.
- That coverage is important because it shows the control plane is not faking a one-shot file write; it is actually driving the interactive program through the same primitives exposed by the CLI.
- The final session result is corroborated by `inspect-final.json`, which records an exited session with exit code `0`.

## Real-world debugging note: `dogfood` -> `dogfood.md`

One useful detail from this run is that the first filename choice (`dogfood`) had to be corrected to `dogfood.md` because the repository already contains a `dogfood/` directory. That small rename is worth preserving in the notes because it shows the demo was interactive and realistic: the operator hit an ordinary naming conflict, adjusted the buffer name, and continued successfully.

## Known gaps

- The screenshot artifacts are **text snapshots derived from the event log**, not rendered terminal frames.
- A renderer-backed screenshot path is not implemented yet, so this bundle does not include pixel-faithful terminal captures.
- No asciicast export is included yet.
- The `gc` command is still out of scope for this bundle.

## Conclusion

This demo proves that the Week 1 `agent-terminal` control plane can drive a sophisticated interactive terminal program like Neovim end to end: launch it, switch modes, enter text, issue editor commands, save a file, navigate with Vim motions, and exit cleanly. Even without a renderer-backed screenshot pipeline, the combination of the session metadata, event log, final inspection output, and text-based screenshots is strong evidence that the control plane works on real terminal software rather than only on purpose-built fixtures.
