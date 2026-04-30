# agent-tty

`agent-tty` manages long-lived terminal sessions and preserves enough state to inspect, replay, and clean them up safely.

## Language

**Session**:
A long-lived PTY-backed terminal instance owned by `agent-tty`.

**Event Log**:
The append-only history of a **Session**'s terminal output, user inputs, control actions, and lifecycle events. It is the canonical source used to reconstruct **Session** state for replay and artifact generation.

**Session Status**:
The lifecycle state of a **Session**: `running`, `exiting`, `exited`, `failed`, `destroying`, or `destroyed`.

**Active Session**:
A **Session** whose host-side lifecycle may still be in progress.

**Terminal Session**:
A **Session** whose host-side lifecycle has reached a final persisted state.
_Avoid_: Finished session

**Commandable Session**:
A **Session** that can still accept user input and control commands.

**Command Target**:
The **Commandable Session** selected and verified as eligible to receive an input or control command.
_Avoid_: Running Session Target

**Waited Run**:
A run request where the caller asks `agent-tty` to wait until the command's completion signal is observed.
_Avoid_: Blocking run

**Run Completion**:
The host-observed end point for a **Waited Run**, distinct from **Session** exit and caller timeout.
_Avoid_: Command finish, session completion

**Render Wait**:
A wait request whose condition is evaluated against renderer-produced **Semantic Snapshots**.
_Avoid_: Visual wait, snapshot wait

**Screen Stability**:
A render condition where the visible text content of a **Semantic Snapshot** has remained unchanged for a requested duration.
_Avoid_: Settled screen

**Live Host Eligible Session**:
A **Session** where callers should ask the live session host for fresh state.

**Offline Replay Eligible Session**:
A **Session** where callers should reconstruct renderer state from persisted replay data.

**Collectable Session**:
A **Terminal Session** whose persisted directory may be removed by garbage collection.
_Avoid_: Deletable session

**Destroyed Status Check**:
A convenience policy predicate for the single `destroyed` **Session Status** value. It is not a separate lifecycle classification.

**Semantic Snapshot**:
A renderer-produced semantic description of a **Session** at a captured event-log sequence.

**Snapshot Result**:
A public snapshot payload returned to a caller after deriving structured or text output from a **Semantic Snapshot**.

**Snapshot Artifact**:
A persisted JSON artifact containing exactly the **Snapshot Result** returned to the caller.

**Snapshot Capture**:
The operation that derives a **Snapshot Result** from a **Semantic Snapshot** and records the matching **Snapshot Artifact**.
_Avoid_: Renderer capture

**Screenshot Result**:
A public screenshot payload returned to a caller describing the rendered PNG of a **Session** at a captured event-log sequence.

**Screenshot Artifact**:
A persisted PNG file plus its manifest entry recording the **Screenshot Result** for a **Session** at a captured event-log sequence.

**Screenshot Capture**:
The operation that invokes the renderer to produce the PNG, builds the **Screenshot Result**, and records the matching **Screenshot Artifact**.
_Avoid_: Renderer capture

**Release Prep Workflow**:
The maintainer-facing process for choosing the next release version and preparing release changes for review before they land on the default branch.

**Release Finalization Step**:
The post-merge process that creates and publishes the release tag from the default branch after release prep changes have landed.

**Publish Pipeline**:
The tag-triggered automation that validates, packages, and publishes a release after the **Release Finalization Step**.

### Triage operations

**AFK Triage**:
A non-interactive run of the `triage` skill, driven by sandcastle inside a **Coder workspace**, that applies labels and posts comments directly without a maintainer in the loop. Routes low-confidence outcomes to `needs-info` instead of waiting.
_Avoid_: "automated triage", "bot triage"

**Triage Batch**:
The set of issues processed by one parent-script invocation of **AFK Triage**. Spawns one **Coder workspace** and one **Triage Agent** per issue, bounded by a configurable parallelism cap.
_Avoid_: "triage round", "triage wave"

**Triage Agent**:
A Claude Code instance executing **AFK Triage** on exactly one issue. Distinct from a **Coder workspace agent**.
_Avoid_: bare "agent" (overloaded — see Flagged ambiguities)

**Coder workspace**:
A remote development environment provisioned by [Coder](https://coder.com) that hosts exactly one **Triage Agent** and its repo checkout. External concept owned by Coder; always qualify as "Coder workspace" to keep this project's **Session** terminology unambiguous.
_Avoid_: bare "workspace", "Coder VM", "Coder sandbox"

**Coder workspace agent**:
The daemon Coder runs inside a **Coder workspace** that the Coder control plane connects to for SSH/exec. Distinct from a **Triage Agent**.
_Avoid_: bare "agent", "Coder agent"

## Relationships

- A **Session** has exactly one **Session Status** at a time.
- A `running` **Session** is **Active**, **Commandable**, and **Live Host Eligible**.
- An `exiting` **Session** is **Active** and **Live Host Eligible**, but not **Commandable**.
- A `destroying` **Session** is **Active** and **Offline Replay Eligible**, but not **Terminal** or **Collectable**.
- `exited`, `failed`, and `destroyed` **Sessions** are **Terminal**, **Offline Replay Eligible**, and **Collectable**.

- A **Session** has one **Event Log**.
- An **Offline Replay Eligible Session** is reconstructed from its persisted **Event Log** and manifest.
- A **Snapshot Result** is derived from exactly one **Semantic Snapshot**.
- A **Snapshot Artifact** contains exactly the **Snapshot Result** emitted to the caller.
- A **Screenshot Capture** produces exactly one **Screenshot Result** and exactly one **Screenshot Artifact** for the same captured event-log sequence.
- A **Screenshot Artifact** is the persisted PNG plus its manifest entry that the **Screenshot Result** describes to the caller.
- A **Command Target** is exactly one **Commandable Session** selected by an input or control command.
- A **Commandable Session** can accept a **Waited Run**.
- A **Render Wait** may include text, regex, cursor, or **Screen Stability** conditions.
- A **Render Wait** may be evaluated by live host polling for a **Live Host Eligible Session** or by offline replay fallback for an **Offline Replay Eligible Session**.
- Offline replay fallback can evaluate snapshot content and cursor position, but cannot prove elapsed **Screen Stability** duration from a single latest **Semantic Snapshot**.
- A **Waited Run** may produce one **Run Completion**, time out for its caller, or be interrupted by **Session** exit.
- Caller timeout does not cancel the underlying **Run Completion**; it may still be observed later to keep internal completion bytes out of artifacts.
- After **Session** exit, an unobserved **Run Completion** can no longer arrive.
- A **Release Prep Workflow** produces local, reviewable release changes before any release tag exists.
- A **Release Finalization Step** happens after the **Release Prep Workflow** has landed on the default branch.
- A **Release Finalization Step** produces the release tag consumed by the **Publish Pipeline**.
- A **Publish Pipeline** starts from the release tag and owns release packaging and publishing.

- A **Triage Batch** processes one or more `needs-triage` issues, plus `needs-info` issues with new reporter activity since their last triage notes.
- A **Triage Batch** spawns exactly one **Coder workspace** and one **Triage Agent** per issue it processes, capped by `TRIAGE_PARALLELISM`.
- A **Coder workspace** hosts exactly one **Triage Agent** and is destroyed when that agent's run ends (success, failure, or timeout).
- A **Triage Agent** has a checkout of this repo inside its **Coder workspace** and may attempt reproduction (for bug issues) before producing an agent brief or routing to `needs-info`.
- An **AFK Triage** outcome moves the issue to `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, or leaves it at `needs-triage` with notes — never silent.

## Example dialogue

> **Dev:** "Can garbage collection remove a **destroying** **Session**?"
> **Domain expert:** "No. It is still an **Active Session**, even though renderer inspection should use **Offline Replay** instead of the live host."

> **Dev:** "Does **Snapshot Capture** ask the renderer for terminal state?"
> **Domain expert:** "No. The renderer first produces a **Semantic Snapshot**; **Snapshot Capture** derives and records the public result from that snapshot."

> **Dev:** "Should `snapshot` resolve a **Command Target**?"
> **Domain expert:** "No. A **Command Target** is for commands that must send input or control to a **Commandable Session**, not inspection or replay operations."

> **Dev:** "If a **Waited Run** times out, did the command finish?"
> **Domain expert:** "No. The caller stopped waiting, but the **Run Completion** may still arrive later and must still be recognized."

> **Dev:** "If offline replay finds the requested text, did a **Screen Stability** **Render Wait** match?"
> **Domain expert:** "No. Offline replay can show the latest **Semantic Snapshot**, but only live polling can prove the visible content stayed unchanged for the requested duration."

> **Dev:** "Two **Triage Batches** kicked off five minutes apart — what happens to issue #142?"
> **Domain expert:** "The first creates `agent-tty-triage-142`, processes it, and deletes the **Coder workspace**. The second starts five minutes later, sees `coder create agent-tty-triage-142` succeed because the first batch already cleaned up, queries the issue, finds it no longer carries `needs-triage`, and exits without action."

> **Dev:** "If an **AFK Triage** can't reproduce a bug, what does it write?"
> **Domain expert:** "Not a `ready-for-agent` brief. It posts a `needs-info` comment listing exactly what it tried, what failed, and the specific details it needs from the reporter; applies the `needs-info` label; and exits. The next **Triage Batch** picks the issue up after the reporter replies."

## Flagged ambiguities

- "Active" and "offline replay eligible" are independent classifications: `destroying` is both **Active** and **Offline Replay Eligible**.
- "Running Session Target" was used during design discussion, but the canonical term is **Command Target** because commandability is the policy being resolved.
- "agent" is overloaded across three referents: this project's **Triage Agent** (a Claude Code instance), Coder's **Coder workspace agent** (the SSH/exec daemon), and a generic AFK implementation agent (the actor on `ready-for-agent` issues — Phase 2 of the triage pipeline). Always qualify in code comments and docs.
