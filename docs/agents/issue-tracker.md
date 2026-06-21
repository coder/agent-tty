# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## GitHub issue triage workflow setup

Before running the `github-issue-triage` workflow, verify the repository has the automation-state labels documented in `docs/agents/triage-labels.md`:

```sh
gh label list --search 'triage:'
```

The workflow defaults to open issues labelled `needs-triage`, skips issues labelled `triage:done`, and defers issues labelled `triage:ongoing`. It investigates candidates in isolated agent workspaces so bug reports can be reproduced or prototyped before producing maintainer-reviewable triage reports, public-comment drafts, and allowlisted label plans. It does not mutate GitHub directly; posting comments and applying labels require an external deterministic publisher that verifies the target issue, comment marker, author, and final labels. Use an explicit `repository` when running it outside a normal checked-out project context.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
