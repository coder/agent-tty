# Plan 003: RELEASE.md no longer claims a stale "0.2.x" release line

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c11e2e2..HEAD -- RELEASE.md package.json`
> If `RELEASE.md` changed since this plan was written, compare the "Current
> state" excerpt against the live file before editing; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `c11e2e2`, 2026-06-16

## Why this matters

`RELEASE.md` is the user-facing **support contract** — `README.md` links to it
("The supported contract is in `RELEASE.md`"). Its opening still says the
document covers the "current `0.2.x` release line" and calls `0.2.0` "the first
stable cut", but the product is at `0.4.3` (`package.json`) and the project now
releases via release-please, which bumps the version automatically. A reader
checking what's supported sees a version line that is two minor releases stale.
The body of the contract is capability-based and still accurate; only the
version framing in the first two lines is wrong. Making that framing
**version-agnostic** fixes the drift and prevents it from recurring on the next
release-please bump.

## Current state

**`RELEASE.md:1-7`** (the only stale part — the rest of the file is
capability-based and correct):

```markdown
# agent-tty release contract

This document defines the supported product contract for the current `0.2.x` release line.
The `0.1.x` beta line established the baseline for isolated, reviewable terminal automation for real TUI workflows, and `0.2.0` is the first stable cut on top of that baseline; later `0.2.x` releases may add compatible fixes and features without widening this core support contract.
If a workflow depends on behavior outside this document, treat it as future-scope or best-effort rather than a guaranteed capability.

For per-release changes, see [`CHANGELOG.md`](./CHANGELOG.md). For release mechanics, use [`docs/RELEASE-PROCESS.md`](./docs/RELEASE-PROCESS.md). For reviewer-facing proof bundles, start with [`dogfood/CATALOG.md`](./dogfood/CATALOG.md).
```

`package.json:3` is `"version": "0.4.3"`. The linked files
`docs/RELEASE-PROCESS.md`, `CHANGELOG.md`, and `dogfood/CATALOG.md` all exist
(verified) — **do not** change those links.

The rest of `RELEASE.md` (the "Supported capabilities", "Explicitly out of
scope", "Known limitations", "Validation" sections, lines 9-39) is accurate and
**must not change** — note that line 20 already correctly references the shipped
`libghostty-vt` semantic renderer.

### Conventions to follow

- Markdown prose; oxfmt formats `*.md` (see `mise.toml` `format-check` sources),
  so run the formatter after editing.
- Keep the contract **capability-based and version-agnostic** so release-please
  version bumps don't re-stale it. Do not hardcode `0.4.x` (it would drift
  again); describe the contract without pinning a release-line number.

## Commands you will need

| Purpose      | Command                | Expected on success |
| ------------ | ---------------------- | ------------------- |
| Format (fix) | `npm run format`       | exit 0              |
| Format check | `npm run format:check` | exit 0              |

## Scope

**In scope**:

- `RELEASE.md` — only lines 3-4 (the version framing).

**Out of scope**:

- The capability/limitation/validation sections of `RELEASE.md` (lines 9-39).
- The links on line 7 (all targets exist).
- `README.md`, `CHANGELOG.md` (automation-owned), `package.json`, and any
  release workflow.

## Git workflow

- Branch: `advisor/003-fix-release-contract-version`
- Conventional Commits. Example: `docs: make the RELEASE.md support contract version-agnostic`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make the opening version-agnostic

Replace lines 3-4 of `RELEASE.md` with version-agnostic phrasing. Target text
(keep line 5 — "If a workflow depends…" — and everything below unchanged):

```markdown
This document defines the supported product contract for the current stable release line.
It builds on the `0.1.x` beta baseline for isolated, reviewable terminal automation of real TUI workflows; later stable releases may add compatible fixes and features without widening this core support contract.
```

(The exact wording can vary, but it must not name a specific `0.2.x`/`0.x`
"current" release line. The first stable baseline reference to `0.1.x` is
historically accurate and fine to keep.)

**Verify**: `grep -n "0.2" RELEASE.md` → returns nothing (no remaining `0.2.x`
/ `0.2.0` references).

### Step 2: Format

Run `npm run format`, then `npm run format:check` → exit 0.

**Verify**: `npm run format:check` → exit 0.

## Test plan

No code; the checks are:

- `grep -n "0\.2\.[0-9x]" RELEASE.md` → no matches.
- `npm run format:check` → exit 0.
- Manual read: lines 9-39 are unchanged from the current file.

## Done criteria

ALL must hold:

- [ ] `grep -nE "0\.2\.[0-9x]" RELEASE.md` returns no matches.
- [ ] `RELEASE.md` no longer contains the phrase "first stable cut" tied to a
      version (or any "current `0.x.y` release line" claim).
- [ ] `npm run format:check` exits 0.
- [ ] Only `RELEASE.md` is modified (`git status`); no `CHANGELOG.md` change.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- `RELEASE.md`'s opening no longer matches the excerpt above (it was already
  edited).
- Any of the links on line 7 point to a file that no longer exists
  (`ls docs/RELEASE-PROCESS.md CHANGELOG.md dogfood/CATALOG.md`) — that's a
  separate doc-rot finding; report it, don't fix it here.

## Maintenance notes

- Keeping the contract version-agnostic means future release-please bumps won't
  re-stale this file. If the team later wants an explicit version stamp, the
  durable way is a release-please-managed marker (like the
  `<!-- x-release-please-version -->` comment used in `README.md`) rather than
  hand-edited prose — that's a deliberate follow-up, not part of this plan.
