# Agent Uses agent-tty Dogfood Bundle

This evergreen bundle records coding agents using the public `agent-tty` CLI to drive a clean Neovim session. It supports Codex and Claude modes and writes reviewer-facing artifacts under `dogfood/agent-uses-agent-tty/artifacts/`.

## Demo Recordings

| Agent  | Outer agent recording                                                                            | Inner Neovim recording                                                                                                         | File proof                                                               |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Codex  | [![Codex recording thumbnail](./artifacts/codex-thumbnail.png)](./artifacts/codex-outer.webm)    | [`codex-inner-nvim.webm`](./artifacts/codex-inner-nvim.webm), [`codex-inner-nvim.cast`](./artifacts/codex-inner-nvim.cast)     | [`codex-final-file-proof.txt`](./artifacts/codex-final-file-proof.txt)   |
| Claude | [![Claude recording thumbnail](./artifacts/claude-thumbnail.png)](./artifacts/claude-outer.webm) | [`claude-inner-nvim.webm`](./artifacts/claude-inner-nvim.webm), [`claude-inner-nvim.cast`](./artifacts/claude-inner-nvim.cast) | [`claude-final-file-proof.txt`](./artifacts/claude-final-file-proof.txt) |

The outer recording shows the Codex or Claude interactive TUI running inside an `agent-tty` session. The inner recording is the nested `agent-tty` session that the agent created to control `nvim --clean -n demo-note.txt`.
The thumbnail links point to slowed review cuts trimmed to the final visible agent/`agent-tty` interaction. The untrimmed outer WebM is kept as `artifacts/*-outer-full.webm`.

## Reproduce

From the repository root:

```bash
bash dogfood/agent-uses-agent-tty/reproduce.sh --agent codex
bash dogfood/agent-uses-agent-tty/reproduce.sh --agent claude
bash dogfood/agent-uses-agent-tty/reproduce.sh --agent both
```

`--agent both` is the default.

The script builds the local package, packs it, installs the tarball into a temporary prefix, prepends that prefix to `PATH`, and records the demo with public `agent-tty ...` commands. It also writes a checked helper script into the disposable workspace so the nested agent can run one deterministic command while the helper prints and executes the public `agent-tty ...` flow. It does not use repo-local `npx tsx src/cli/main.ts ...` inside the recorded agent runs.

## Prerequisites

- Project dependencies are installed.
- `node`, `npm`, `jq`, `ffmpeg`, `ffprobe`, `nvim`, and `shasum` are available.
- Playwright Chromium is available for screenshot and WebM export.
- Codex mode requires `codex` on PATH and `codex login status` to succeed.
- Claude mode requires `claude` on PATH and `claude auth status` to succeed.

The script records only sanitized auth status in `environment.txt`; it does not write Claude account details or Codex credential details into the bundle.
Codex mode uses `codex --dangerously-bypass-approvals-and-sandbox` because the run is already isolated to temporary workspaces and the inner `agent-tty doctor`/WebM checks need normal local browser access.

## Isolation And Cleanup

Each agent run uses:

- a temporary `agent-tty` install prefix,
- a temporary outer `agent-tty` home for the agent recording,
- a temporary inner `agent-tty` home for the Neovim session,
- a temporary git workspace,
- isolated Neovim XDG config, data, state, and cache directories.

Temporary directories are removed on exit. Set `KEEP_AGENT_USES_AGENT_TTY_TEMP=1` when debugging a failed run.
Set `AGENT_USES_AGENT_TTY_REVIEW_TAIL_SECONDS` and `AGENT_USES_AGENT_TTY_REVIEW_SLOWDOWN` to tune the linked review cuts; the defaults keep the last 6 seconds of the full recording and slow that segment by 5x.

## Bundle Contents

- `reproduce.sh` — self-contained generator.
- `prompts/codex.md` and `prompts/claude.md` — prompt templates used for the nested agent runs.
- `environment.txt` — generated environment and auth-check summary.
- `*-outer-*.json` — generated CLI envelopes for the outer recording session.
- `artifacts/*-outer.webm` — trimmed review cut of the coding agent process.
- `artifacts/*-outer-full.webm` and `artifacts/*-outer.cast` — untrimmed recordings of the coding agent process.
- `artifacts/*-thumbnail.png` — README thumbnails copied from `agent-tty screenshot`.
- `artifacts/*-inner-nvim.webm` and `artifacts/*-inner-nvim.cast` — artifacts exported by the nested coding agent.
- `artifacts/*-demo-note.txt` and `artifacts/*-final-file-proof.txt` — final file proof.
- `artifacts/*-agent-transcript.txt` and `artifacts/*-final-message.txt` — captured agent output.

## Adding Another Agent

1. Add `prompts/<agent>.md` with the same placeholders used by the existing templates.
2. Extend `selected_agents`, `write_runner`, and argument validation in `reproduce.sh`.
3. Add a README row for the new `artifacts/<agent>-*` outputs.
4. Run `bash dogfood/agent-uses-agent-tty/reproduce.sh --agent <agent>` and confirm the generated file proof, outer recording, inner recording, thumbnail, and transcript are non-empty.

## References

- [Codex CLI](https://developers.openai.com/codex/cli)
- [Claude Code getting started](https://code.claude.com/docs/en/getting-started)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [GitHub attachment file types](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
