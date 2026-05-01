# ADR 0004: AFK Triage applies decisions automatically, escalates via `needs-info`

Date: 2026-04-30

## Status

Accepted

## Context

The `triage` skill (`.agents/skills/triage/SKILL.md`) is written for an interactive `/triage` invocation: the agent recommends a category and state with reasoning, then **waits for the maintainer to direct it** before applying labels or posting comments (`SKILL.md:65`). The new sandcastle-driven workflow runs **AFK Triage** in parallel **Coder workspaces** with no human at the keyboard during a run. The skill's "wait for direction" step has no answer in that environment, and we needed to choose what AFK Triage does instead.

We considered three apply modes:

- **Pure draft.** Agent posts a recommendation comment but never edits labels or closes issues. Maintainer applies the outcome later.
- **Pure auto-apply.** Agent decides and applies the label, comment, or close directly.
- **Hybrid by transition risk.** Auto-apply cheap transitions (`needs-info`, staying at `needs-triage`); draft the sticky ones (`ready-for-agent`, `ready-for-human`, `wontfix`).

A later grilling pass found one v1 exception: enhancement `wontfix` is not just a tracker transition. The skill requires writing `.out-of-scope/<concept>.md` before linking to it and closing the issue (`SKILL.md:75-76`), but the v1 AFK Triage workflow does not persist repository changes, open PRs, or delegate to implementation agents.

## Decision

**AFK Triage runs in full auto-apply mode**, with `needs-info` as the agent's escape valve for low-confidence outcomes and a v1 enhancement-`wontfix` exception.

Concretely:

- For `ready-for-agent`, `ready-for-human`, and bug `wontfix`: the agent applies the label and posts the role's templated comment without waiting for a human. Bug `wontfix` may close the issue when the reasoning is clear.
- For enhancement `wontfix` in v1: the agent **must not auto-close**. It applies `ready-for-human` and posts a comment containing the recommended `.out-of-scope/<concept>.md` entry plus the rationale, or routes to `needs-info` if more input is required. Auto-close with `.out-of-scope` persistence is deferred until a future iteration can open a PR or delegate to the implementation-agent phase.
- When the agent is uncertain — conflicting signals, missing repro details, ambiguous scope, failed reproduction — it routes to `needs-info`. The `needs-info` template (`SKILL.md:83-99`) becomes the AFK question channel: specific, answerable questions posted on the issue itself.
- The reporter's reply is read on a subsequent **Triage Batch**, using the existing "Resuming a previous session" flow (`SKILL.md:101-103`) without modification.
- Every AFK comment starts with the AI-triage disclaimer (`SKILL.md:10-14`) and includes a machine-readable HTML marker: `<!-- afk-triage:v1 issue=<n> outcome=<state> run=YYYYMMDDTHHMMSSZ -->` (compact UTC, no delimiters; the eligibility parser `/^\d{8}T\d{6}Z$/` rejects extended ISO-8601 like `2026-04-30T14:15:00Z`). See [`docs/agents/afk-triage.md`](../agents/afk-triage.md) for the full format spec and rationale.

The **Coder workspace** is essential to this decision, not incidental. It gives each **Triage Agent** a real checkout and a real toolchain so reproduction (`SKILL.md:67-68`) can happen AFK. Reproduction is the load-bearing input to the auto-apply confidence: a confirmed repro promotes a bug toward `ready-for-agent` with detailed repro steps in the agent brief; a failed or absent repro routes to `needs-info`. Without per-agent workspaces, AFK Triage could not carry the decision weight that "full auto-apply" implies — it would either ship unverified briefs or fall back to draft mode. This is also why a simpler "GitHub Action runs Claude Code on the runner" topology was rejected: the runner is shared, polluted by the project's installed dependencies between runs, and offers no per-issue isolation for parallel reproductions.

## Considered options

- **Pure draft** preserves human-in-the-loop strictly but gives up most of the AFK leverage — the maintainer still pushes every button, even when the agent is highly confident. Rejected because the goal is to remove maintainer toil, not just shift it.
- **Hybrid by transition risk** matched the asymmetry between cheap and sticky outcomes, but introduced two simultaneous policies the maintainer has to remember and reason about. Rejected because the `needs-info` escape valve already encodes the same risk asymmetry: low-confidence outcomes route to `needs-info` (cheap, reversible), high-confidence outcomes route to a real label (the agent's certainty is the gate). One policy, not two.
- **Auto-apply with maintainer-mention review** (post `@maintainer please confirm`) was discussed during grilling. Rejected because it recreates the human bottleneck without the type-system clarity of a state-machine label; the issue tracker already has a "request input" state, and that's `needs-info`.
- **Auto-close enhancement `wontfix` after writing `.out-of-scope/` directly** would match the imported skill, but v1 triage agents do not persist repo changes. Adopted alternative: route likely enhancement `wontfix` to `ready-for-human` with the exact recommended `.out-of-scope` entry and rationale so a human can review and persist it.

## Consequences

- Triage outcomes are visible in the tracker the moment a **Triage Agent** finishes, not after a maintainer review pass.
- A wrong bug `wontfix` is reversible but visibly noisy: the reporter sees the close notification, the maintainer reopens. The bias toward `needs-info` for low-confidence cases keeps this rare; the AGENT-BRIEF template's required Reproduction section reinforces it for bugs by making "no confirmed repro → no `ready-for-agent`" explicit.
- Enhancement `wontfix` is intentionally less automatic in v1: likely rejections become `ready-for-human` comments with recommended `.out-of-scope` text instead of closes. This deviation will be removed when the implementation-agent phase or another mechanism persists `.out-of-scope/` files.
- The skill text (`SKILL.md:65`) still reads "Recommend… Wait for direction". That sentence is interactive-mode behavior; the AFK prompt explicitly overrides it. A future skill amendment may make the dual-mode behavior explicit; for now the AFK prompt carries the override.
- `needs-info → needs-triage` is not automatic in the tracker. v1 handles this by having each scheduled **Triage Batch** process both `needs-triage` issues and `needs-info` issues with new reporter activity since the last triage notes. A separate label-flip reaper may replace this if the dual-query gets noisy.
- Every AFK comment must include both the verbatim disclaimer (`> *This was generated by AI during triage.*`) and the AFK HTML marker. The marker is mandatory for idempotency, for detecting reporter activity since the last AFK note, and for distinguishing AFK comments from maintainer comments while the Coder workspace's GitHub External Auth identity is personal.
- The **Coder workspace** is non-negotiable infrastructure for AFK Triage and is not a substitutable detail. Replacing it with a runner-based topology would invalidate this ADR's premise.
