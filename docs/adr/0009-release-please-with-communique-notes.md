---
status: accepted
---

# Release-please as a library with Communique changelog notes

## Context

The release flow had four moving parts: a per-push workflow that kept an `[Unreleased]` section of `CHANGELOG.md` updated through bot PRs (`update-unreleased-changelog.yml`), local `release:prep` / `release:finalize` scripts (ADR 0002, release-it as the version-file engine), a workflow that wrote the release section onto `release/*` PRs (`release-changelog.yml`), and the tag-triggered Publish Pipeline (`release.yml`). It worked, but with friction:

- Releasing required two local script runs on a literal, clean `main` checkout with `node_modules` installed, and an admin-merge — the maintainer authored the release PR, so they could not approve it themselves under the required-review ruleset.
- The changelog automation produced a continuous stream of `[Unreleased]` PRs whose merges raced other work, and the `[Unreleased]` / `## [v<version>]` heading pair was a contract two workflows depended on.
- Communique ran in three flavors (unreleased section, release section, editorial release notes) across three workflows.

[release-please](https://github.com/googleapis/release-please) provides the desired shape — one continuously maintained release PR whose merge produces the tag and GitHub Release — but its GitHub Action only supports the built-in changelog generators (conventional-commit bullets or GitHub auto-notes). The Communique-written changelog entries are a feature we keep.

## Decision

Run release-please **as a library** from a repo-owned runner (`src/tools/release-please-runner.ts`, executed by `.github/workflows/release-please.yml` on every push to `main`), with Communique registered as a custom changelog-notes type via `registerChangelogNotes('communique', ...)`. The notes hook shells out to `communique generate HEAD <last-release-tag> --concise`, passing release-please's previous-tag so both tools agree on the commit range, and wraps the output in a `## [<version>] - <date>` heading.

Decisions inside that frame:

- **Heading drops the `v`** (`## [0.4.2] - ...`, not `## [v0.4.2] - ...`): release-please recovers version and notes by parsing the merged PR body with `/^#{2,} \[?(\d+\.\d+\.\d+...)/` — a digit must follow the bracket, or merging the PR creates no GitHub Release. Unit tests pin this contract and the CHANGELOG insertion point against the installed release-please internals.
- **No `[Unreleased]` section.** The release PR is the unreleased view. The two workflows that depended on the heading pair are retired with it.
- **Version bumps from Conventional Commits** with `bump-minor-pre-major` + `bump-patch-for-minor-pre-major`, matching the project's pre-1.0 history (breaking → minor, feat/fix → patch); `Release-As` footers override.
- **Tags and releases are created non-draft** by the runner, which then dispatches the existing `release.yml` by tag input — tags created with the workflow token never fire `push: tags` triggers, and the repo already uses explicit `gh workflow run` dispatch for exactly this class of problem (CI on bot branches). `release.yml` keeps quality gates, the verified tarball, editorial Communique notes, assets, and npm trusted publishing unchanged; it briefly leaves the Release with changelog-style notes and no assets until it completes.
- **release-please is a pinned devDependency** installed by the normal `aube ci` bootstrap. Its CJS-only octokit 9.x line carries no npm provenance attestations, so `@octokit/endpoint@9.0.6` is excluded from aube's trust policy in `pnpm-workspace.yaml` with justification.

## Consequences

- Releasing is: review the standing release PR, approve, merge. No local scripts, no admin bypass (the bot authors the PR, so maintainer review satisfies the ruleset), no manual tagging.
- `CHANGELOG.md` is written only through release PRs; entries from v0.4.2 onward use the bracketed no-`v` heading while older entries keep their style. Feature PRs still must not touch the file.
- Notes regenerate from scratch on every push to `main`: an LLM call per push (same cost profile as the retired unreleased workflow), and reviewed wording can drift between pushes — the fix-the-source loop (feature PR bodies, `BEGIN_COMMIT_OVERRIDE`) replaces hand-editing the release PR.
- The runner is ~250 lines we own, pinned to an exact release-please version; the PR-body parsing contract it relies on is undocumented upstream, so version bumps must keep the compatibility tests green.
- Manual tagging remains an emergency path but now requires re-syncing `.release-please-manifest.json` afterwards (documented in `docs/RELEASE-PROCESS.md`).
