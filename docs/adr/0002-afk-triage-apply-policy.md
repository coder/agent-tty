# ADR 0002: AFK Triage applies decisions automatically, escalates via `needs-info`

Date: 2026-04-30

## Status

Accepted

## Context

The `triage` skill (`.agents/skills/triage/SKILL.md`) is written for an interactive `/triage` invocation: the agent recommends a category and state with reasoning, then **waits for the maintainer to direct it** before applying labels or posting comments (`SKILL.md:65`). The new sandcastle-driven workflow runs **AFK Triage** in parallel **Coder workspaces** with no human at the keyboard during a run. The skill's "wait for direction" step has no answer in that environment, and we needed to choose what AFK Triage does instead.

We considered three apply modes:

- **Pure draft.** Agent posts a recommendation comment but never edits labels or closes issues. Maintainer applies the outcome later.
- **Pure auto-apply.** Agent decides and applies the label, comment, or close directly.
- **Hybrid by transition risk.** Auto-apply cheap transitions (`needs-info`, staying at `needs-triage`); draft the sticky ones (`ready-for-agent`, `ready-for-human`, `wontfix`).

## Decision

**AFK Triage runs in full auto-apply mode**, with `needs-info` as the agent's escape valve for low-confidence outcomes.

Concretely:

- For `ready-for-agent`, `ready-for-human`, `wontfix`: the agent applies the label and posts the role's templated comment without waiting for a human. For enhancement `wontfix`, it also writes `.out-of-scope/<concept>.md` per the existing skill (`SKILL.md:74-76`).
- When the agent is uncertain — conflicting signals, missing repro details, ambiguous scope — it routes to `needs-info`. The `needs-info` template (`SKILL.md:73`) becomes the AFK question channel: specific, answerable questions posted on the issue itself.
- The reporter's reply is read on a subsequent **Triage Batch**, using the existing "Resuming a previous session" flow (`SKILL.md:118-124`) without modification.
- Every comment continues to start with the AI-triage disclaimer (`SKILL.md:8-12`), so triage posts are always attributable to automation.

The **Coder workspace** is essential to this decision, not incidental. It gives each **Triage Agent** a real checkout and a real toolchain so reproduction (`SKILL.md:67-68`) can happen AFK. Reproduction is the load-bearing input to the auto-apply confidence: a confirmed repro promotes a bug toward `ready-for-agent` with detailed repro steps in the agent brief; a failed or absent repro routes to `needs-info`. Without per-agent workspaces, AFK Triage could not carry the decision weight that "full auto-apply" implies — it would either ship unverified briefs or fall back to draft mode. This is also why a simpler "GitHub Action runs Claude Code on the runner" topology was rejected: the runner is shared, polluted by the project's installed dependencies between runs, and offers no per-issue isolation for parallel reproductions.

## Considered options

- **Pure draft** preserves human-in-the-loop strictly but gives up most of the AFK leverage — the maintainer still pushes every button, even when the agent is highly confident. Rejected because the goal is to remove maintainer toil, not just shift it.
- **Hybrid by transition risk** matched the asymmetry between cheap and sticky outcomes, but introduced two simultaneous policies the maintainer has to remember and reason about. Rejected because the `needs-info` escape valve already encodes the same risk asymmetry: low-confidence outcomes route to `needs-info` (cheap, reversible), high-confidence outcomes route to a real label (the agent's certainty is the gate). One policy, not two.
- **Auto-apply with maintainer-mention review** (post `@maintainer please confirm`) was discussed during grilling. Rejected because it recreates the human bottleneck without the type-system clarity of a state-machine label; the issue tracker already has a "request input" state, and that's `needs-info`.

## Consequences

- Triage outcomes are visible in the tracker the moment a **Triage Agent** finishes, not after a maintainer review pass.
- A wrong `wontfix` is reversible but visibly noisy: the reporter sees the close notification, the maintainer reopens. The bias toward `needs-info` for low-confidence cases keeps this rare; the AGENT-BRIEF template's required Reproduction section reinforces it for bugs by making "no confirmed repro → no `ready-for-agent`" explicit.
- The skill text (`SKILL.md:65`) still reads "Recommend… Wait for direction". That sentence is interactive-mode behavior; the AFK prompt explicitly overrides it. A future skill amendment may make the dual-mode behavior explicit; for now the AFK prompt carries the override.
- `needs-info → needs-triage` is not automatic in the tracker. v1 handles this by having each scheduled **Triage Batch** process both `needs-triage` issues and `needs-info` issues with new reporter activity since the last triage notes. A separate label-flip reaper may replace this if the dual-query gets noisy.
- The **Coder workspace** is non-negotiable infrastructure for AFK Triage and is not a substitutable detail. Replacing it with a runner-based topology would invalidate this ADR's premise.
