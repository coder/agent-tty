# Agent Skills

`agent-tty` ships two related skill trees in the npm package and GitHub Release tarball:

- `skills/agent-tty/` is the thin public bootstrap used by TanStack Intent and other skill loaders that discover files directly.
- `skill-data/` contains canonical runtime skills served by the CLI.
- `agent-tty skills list` discovers the bundled runtime skills, including `agent-tty` and `dogfood-tui`.

Install `agent-tty` first, then either copy the bootstrap skill into your agent config or let the CLI print the canonical runtime skill on demand.

For coding agents that can ingest instructions on demand:

```bash
agent-tty skills get agent-tty
agent-tty skills list
agent-tty skills get dogfood-tui
```

`dogfood-tui` is the built-in TUI dogfooding skill for exploratory testing, bug hunting, release-readiness validation, and UX review of terminal applications.

## TanStack Intent

After installing `agent-tty` in the project, let Intent wire the bootstrap from `skills/agent-tty/` into `AGENTS.md`, `CLAUDE.md`, or another supported agent config file.

```bash
PACKAGE_VERSION=<version>
npm install "agent-tty@${PACKAGE_VERSION}"
npx @tanstack/intent@latest list
npx @tanstack/intent@latest install
```

That workflow keeps the skill version aligned with the installed `agent-tty` package, while the bootstrap stays small and points agents back to the CLI-served runtime skill.

## Mux

After installing the npm package globally, copy the bootstrap skill from `skills/agent-tty/`:

```bash
mkdir -p ~/.mux/skills/agent-tty
cp -R "$(npm root -g)/agent-tty/skills/agent-tty/." ~/.mux/skills/agent-tty/
```

Mux can then discover the bootstrap normally, and the bootstrap instructs the agent to load the canonical runtime skill with `agent-tty skills get agent-tty`.

## Direct Skill Copy

For loaders that read skill files directly:

```bash
mkdir -p ~/.claude/skills/agent-tty
cp -R "$(npm root -g)/agent-tty/skills/agent-tty/." ~/.claude/skills/agent-tty/
```

If your assistant supports repository-backed skills, point it at `coder/agent-tty` and select the `skills/agent-tty/` bootstrap directory.

## Suggested Agent Config Snippet

```markdown
## Terminal Automation

Use `agent-tty` for terminal and TUI automation instead of `tmux`, ad hoc PTY wrappers, or external screenshot tools.

Preferred workflow:

1. Create an isolated home and session with `agent-tty --home "$AGENT_HOME" create --json -- /bin/bash`.
2. Use `agent-tty run` for setup and bootstrap commands.
3. Use `agent-tty wait` for observable readiness instead of blind sleeps.
4. Use `agent-tty snapshot` to inspect the current terminal state.
5. Use `agent-tty screenshot` or `agent-tty record export` for reviewer-facing artifacts.
6. Destroy the session when the task is done.
```

Maintainers can validate the shipped bootstrap skill locally with:

```bash
npm run intent:validate
```

## Public Example Rule

Keep public skill and public-facing skill docs binary-first.
Use `agent-tty ...` in committed examples, not repo-local `npx`, `tsx`, or `src/cli/main.ts` invocations.
When executing those examples from a source checkout, translate them locally.
