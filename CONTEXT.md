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

**Hero Demo**:
A README-facing demonstration optimized for stable, polished visualization of real coding-agent TUI behavior. It may use an external outer recorder while keeping `agent-tty` responsible for the inner terminal proof artifacts.
_Avoid_: Treating it as the strongest self-dogfood proof.

**Outer Camera**:
The recorder responsible for the visible coding-agent TUI in a **Hero Demo**. It is presentation infrastructure and does not define the product proof by itself.
_Avoid_: Product proof

**Hero Demo Generator**:
The Node/TypeScript workflow that prepares **Manual Demo Regeneration** inputs, generates raw VHS tapes and runner scripts, invokes the **Outer Camera**, validates the **Curated Hero Artifact Set**, and records the run summary. The generated VHS tape owns screen waits and keypresses during recording.
_Avoid_: PTY proxy controller

**Real-Agent Hero Artifact**:
A checked-in **Hero Demo** artifact captured from a real coding-agent CLI such as Codex or Claude Code, rather than from a fixture or mock TUI. It is regenerated manually because it depends on local authentication and live service behavior.
_Avoid_: CI-generated demo, fixture demo

**Manual Demo Regeneration**:
An auth-gated maintainer workflow for refreshing **Real-Agent Hero Artifacts** outside CI. It should be reproducible from documented commands, but not required for ordinary test or release automation.
_Avoid_: CI gate

**Exploratory Hero Demo**:
A **Hero Demo** scenario where the real coding-agent TUI discovers the `agent-tty` skill and CLI, chooses its own command flow, and uses `agent-tty` to drive an inner Neovim workflow and export proof artifacts. The prompt supplies success criteria, required output paths, and a configurable fixed review window, but no prewritten helper script or exact command sequence.
_Avoid_: Nested Helper Proof, scripted helper run

**Curated Hero Artifact Set**:
The reviewer-facing artifact set for a **Hero Demo**: outer WebM, outer thumbnail or screenshot, outer transcript, inner `agent-tty` cast/WebM, final file proof, prompt, and summary. Raw logs and workspaces are debugging aids, not part of the curated set by default.
_Avoid_: Raw artifact dump

**Hero Demo Promotion Bar**:
The evidence threshold for replacing the README-facing demo with a new **Hero Demo**. For real coding-agent TUIs, this requires repeated local regeneration, visual review, and secret-leakage review before promotion.
_Avoid_: One-off smoke

**Hero Claim Boundary**:
The product claim made by the **Hero Demo**. The claim is that real coding-agent TUIs can use `agent-tty` to produce inner proof artifacts, not that `agent-tty` itself recorded the outer coding-agent TUI.
_Avoid_: Outer recording proof

**Promoted Hero Demo**:
A **Hero Demo** that has passed the **Hero Demo Promotion Bar** and replaced the README-facing demo. Once promoted, the old recursive bundle is removed rather than maintained as a separate proof path.
_Avoid_: Parallel recursive demo

**Hero Demo Leak Check**:
The promotion review for **Real-Agent Hero Artifacts** that combines automated text scanning of transcripts, logs, summaries, and generated text artifacts with human visual review of PNG/WebM outputs.
_Avoid_: Text-only secret scanning

**Debug-Only Raw Demo Files**:
Generated VHS tapes, recorder logs, and disposable workspaces from **Manual Demo Regeneration**. They are useful for debugging failed runs but are not part of the **Curated Hero Artifact Set** and should stay ignored by default.
_Avoid_: Promoted artifacts

**Promoted Hero Run Summary**:
The checked-in summary proving the **Hero Demo Promotion Bar** passed. It records three successful local regenerations for Codex and three for Claude, while only one selected **Curated Hero Artifact Set** per agent is promoted for README review.
_Avoid_: Checking in all trial runs

**Hero Demo Promotion Command**:
The maintainer-facing named mise task that runs **Manual Demo Regeneration** through the **Hero Demo Generator**, including smoke/debug modes and the promotion mode that requires the full **Hero Demo Promotion Bar**.
_Avoid_: Direct tsx-only workflow

**Hero Demo Partial Pass**:
A failed promotion state where one coding-agent TUI passes the required regeneration count and another does not. It does not produce a **Promoted Hero Demo**; both Codex and Claude must pass before README and canonical artifact replacement.
_Avoid_: Single-agent promotion

**Hero Demo UI Noise Policy**:
The rule for real coding-agent UI noise in **Real-Agent Hero Artifacts**: suppress or isolate known noise where practical, fail promotion on secrets or account-sensitive details, and tolerate benign product notices that do not dominate the recording.
_Avoid_: Post-hoc cosmetic editing as the default

**Recursive Dogfood Proof**:
A dogfood scenario where an outer `agent-tty` **Session** records a coding-agent TUI that creates an inner `agent-tty` **Session** and exports proof artifacts. It proves `agent-tty` can capture coding-agent TUIs, but is not required to be the primary polished demo.
_Avoid_: Hero Demo, README demo

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
- A **Promoted Hero Demo** replaces the existing recursive README demo entirely; the old recursive bundle is deleted rather than maintained in parallel.
- The **Hero Claim Boundary** narrows the README claim after that deletion: the outer TUI is presentation, while inner `agent-tty` artifacts are the product proof.
- An **Exploratory Hero Demo** is the preferred **Hero Demo** scenario because it shows the coding-agent TUI discovering the `agent-tty` skill and CLI before producing inner `agent-tty` proof artifacts.
- A **Curated Hero Artifact Set** is what README and reviewer docs link to; raw recorder logs remain local/debug artifacts unless explicitly promoted.
- The **Hero Demo Promotion Bar** for real Codex and Claude recordings is three successful local regenerations per agent, plus visual and secret-leakage review.
- VHS, ttyd, and ffmpeg are pinned as repo tools for named demo tasks, but ordinary CI does not regenerate real-agent **Hero Demo** artifacts.
- The **Hero Demo Generator** relies on repo-pinned VHS, ttyd, and ffmpeg tools rather than transient unpinned local installations.
- The refactor to a **Promoted Hero Demo** is intended to land as one coherent change: generator, tool pins, promoted artifacts, README/catalog updates, manifest updates, and recursive-bundle deletion.
- A **Hero Demo Promotion Command** is exposed as a named mise task and delegates to the Node/TypeScript **Hero Demo Generator**.
- The **Hero Demo Generator** has default Codex/Claude model and effort settings, supports overrides, and records the resolved versions and settings in the **Promoted Hero Run Summary**.
- A **Hero Demo Partial Pass** fails promotion for the whole **Hero Demo**; Codex and Claude must both pass the promotion bar before replacement.
- A **Promoted Hero Run Summary** is checked in with the selected Codex and Claude **Curated Hero Artifact Sets**; extra successful trial outputs remain **Debug-Only Raw Demo Files**.
- A **Promoted Hero Demo** uses WebM as its primary outer video format and PNG thumbnails for README links.
- `dogfood/agent-uses-agent-tty/manifest.json` remains the canonical manifest for the **Curated Hero Artifact Set**, including sha256 and byte counts for promoted artifacts.
- **Debug-Only Raw Demo Files** remain ignored by default; promoted review links should point to the **Curated Hero Artifact Set**.
- A **Hero Demo Leak Check** combines automated text scanning with human visual review before promotion.
- A **Hero Demo UI Noise Policy** is applied during promotion review: names, emails, billing/account lines, auth warnings, tokens, and absolute home paths block promotion; generic update or product notices may remain if they do not dominate.
- A **Real-Agent Hero Artifact** is produced by **Manual Demo Regeneration**, not by CI, because real coding-agent CLIs require local authentication and may show account-, update-, or service-dependent UI.
- A **Hero Demo Generator** generates raw VHS tapes and runner scripts, invokes VHS as the **Outer Camera**, and validates the resulting **Curated Hero Artifact Set**.
- In a **Hero Demo**, the generated VHS tape owns screen waits and keypresses during recording; the **Hero Demo Generator** owns setup, invocation, artifact validation, and summary reporting around that tape.
- A **Hero Demo** may use a recorder outside `agent-tty` for the outer coding-agent TUI, but the demonstrated product proof remains the inner `agent-tty` artifact set.
- A **Recursive Dogfood Proof** uses `agent-tty` for both the outer coding-agent recording and the inner terminal proof artifacts.
- A **Hero Demo** and a **Recursive Dogfood Proof** may cover the same scenario, but they optimize for different review questions: presentation stability versus self-dogfood coverage.
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
- "controller" was used during design discussion for the Hero Demo, but the canonical term is **Hero Demo Generator** because the settled design generates raw VHS tapes rather than actively proxying PTY control during recording.
- "helper proof" was used during design discussion, but the canonical scenario is now **Exploratory Hero Demo**: success criteria and output paths are fixed, while the coding agent chooses the command flow inside a configurable fixed review window.
- "demo" and "proof" are not interchangeable for coding-agent recordings: a **Hero Demo** optimizes for stable presentation, while a **Recursive Dogfood Proof** optimizes for self-dogfood coverage.
- "agent" is overloaded across three referents: this project's **Triage Agent** (a Claude Code instance), Coder's **Coder workspace agent** (the SSH/exec daemon), and a generic AFK implementation agent (the actor on `ready-for-agent` issues — Phase 2 of the triage pipeline). Always qualify in code comments and docs.
