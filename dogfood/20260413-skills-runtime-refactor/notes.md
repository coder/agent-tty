# Skills runtime refactor proof bundle

- **Date:** 2026-04-13
- **Bundle:** `dogfood/20260413-skills-runtime-refactor/`
- **CLI entrypoint:** `npx tsx src/cli/main.ts`
- **CLI Node:** `v24.14.1`
- **npm:** `10.9.3`
- **Git commit:** `2026f5c`
- **Isolated home:** `/tmp/tmp.FCAJKW974f` (cleaned up after `tui-destroy.json`)
- **Session ID:** `01KP34JQENXVMGTMHQW8GSTHJH`
- **Fixture:** `npx tsx test/fixtures/apps/hello-prompt/main.ts`

## What was validated

1. **Skills CLI surface** — `skills list`, `skills get`, and `skills path` all returned successful JSON envelopes with `"ok": true`.
2. **Bundled skills discovery** — `skills-list.json` lists both `agent-tty` and `dogfood-tui`.
3. **Runtime skill resolution** — `skills get` and `skills path` both resolve to `skill-data/`, proving the runtime CLI serves the canonical bundled skill files rather than the thin bootstrap under `skills/`.
4. **Tarball packaging** — `npm-pack-skill-files.txt` shows both `skills/agent-tty/SKILL.md` and the runtime `skill-data/` entries are included in `npm pack --json --dry-run`.
5. **dogfood-tui workflow** — the isolated `hello-prompt` session followed the dogfood skill pattern: `doctor`, `create`, `wait`, `type`, `send-keys`, `snapshot`, `screenshot`, `record export`, `inspect`, and `destroy`.

## Key runtime paths

- `skills-list.json` reported bundled entries for both `agent-tty` and `dogfood-tui`
- `skills-get-agent-tty.json` resolved to `/home/coder/.mux/src/agent-terminal/agent_exec_db10489d06/skill-data/agent-tty/SKILL.md`
- `skills-get-dogfood-tui.json` resolved to `/home/coder/.mux/src/agent-terminal/agent_exec_db10489d06/skill-data/dogfood-tui/SKILL.md`
- `skills-path-agent-tty.json` resolved to `/home/coder/.mux/src/agent-terminal/agent_exec_db10489d06/skill-data/agent-tty`
- `skills-path-dogfood-tui.json` resolved to `/home/coder/.mux/src/agent-terminal/agent_exec_db10489d06/skill-data/dogfood-tui`

## TUI proof artifacts

- `tui-snapshot-text.json` — searchable text proof of the echoed `Agent` response
- `tui-screenshot-echo.json` + `screenshots/hello-prompt-echo.png` — visual proof of the prompt and echoed input
- `tui-record-export-cast.json` + `recordings/hello-prompt.cast` — asciicast replay of the session
- `tui-record-export-webm.json` + `recordings/hello-prompt.webm` — WebM replay of the session
- `tui-inspect-final.json` — confirms the fixture exited before destroy
- `command-log.tsv` — exact commands run, including the screenshot copy and validation step

## Expected vs actual

Expected: the refactored `skills list/get/path` surface should expose bundled runtime skills from `skill-data/`, `npm pack --json --dry-run` should include both `skills/` and `skill-data/`, and the new `dogfood-tui` workflow should produce reviewable screenshot and recording artifacts.

Actual: all required command envelopes parsed successfully with `"ok": true`; `skills list` included both bundled skills; `skills get` content matched the on-disk `skill-data/*/SKILL.md` files byte-for-byte; `skills path` resolved to the runtime `skill-data/<name>` directories; `npm pack --json --dry-run` listed both the bootstrap `skills/agent-tty/SKILL.md` file and the runtime `skill-data/` copies; and the `hello-prompt` dogfood run produced a non-empty PNG screenshot plus both `.cast` and `.webm` recordings.
