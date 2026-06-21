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
gh label list --search 'risk:'
```

The workflow defaults to open issues labelled `needs-triage`, skips issues labelled `triage:done`, defers issues labelled `triage:ongoing`, and skips issues labelled `triage:stopped`. Eligible issues first pass a read-only prompt-injection classifier ensemble. Medium/high-risk issues are not investigated; they produce stop plans for `triage:stopped` plus `risk:medium` or `risk:high` so a maintainer can review them.

Low-risk issues are investigated in isolated agent workspaces so bug reports can be reproduced or prototyped before producing maintainer-reviewable triage reports, public-comment drafts, and allowlisted label plans. The workflow itself does not mutate GitHub; it emits deterministic publish plans for `scripts/github-issue-triage-publish.mjs`. Run that script outside the LLM workflow boundary to post marker comments and apply only validated labels. The publisher re-checks current labels and the classifier full-conversation hash before mutating, and it treats an existing marker as published only when the authenticated publisher authored the marker comment. Use an explicit `repository` when running it outside a normal checked-out project context.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
