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

## Example dialogue

> **Dev:** "Can garbage collection remove a **destroying** **Session**?"
> **Domain expert:** "No. It is still an **Active Session**, even though renderer inspection should use **Offline Replay** instead of the live host."

> **Dev:** "Does **Snapshot Capture** ask the renderer for terminal state?"
> **Domain expert:** "No — the renderer first produces a **Semantic Snapshot**; **Snapshot Capture** derives and records the public result from that snapshot."

## Flagged ambiguities

- "Active" and "offline replay eligible" are independent classifications: `destroying` is both **Active** and **Offline Replay Eligible**.
