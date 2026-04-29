# agent-tty

`agent-tty` manages long-lived terminal sessions and preserves enough state to inspect, replay, and clean them up safely.

## Language

**Session**:
A long-lived PTY-backed terminal instance owned by `agent-tty`.

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

## Relationships

- A **Session** has exactly one **Session Status** at a time.
- A `running` **Session** is **Active**, **Commandable**, and **Live Host Eligible**.
- An `exiting` **Session** is **Active** and **Live Host Eligible**, but not **Commandable**.
- A `destroying` **Session** is **Active** and **Offline Replay Eligible**, but not **Terminal** or **Collectable**.
- `exited`, `failed`, and `destroyed` **Sessions** are **Terminal**, **Offline Replay Eligible**, and **Collectable**.

## Example dialogue

> **Dev:** "Can garbage collection remove a **destroying** **Session**?"
> **Domain expert:** "No. It is still an **Active Session**, even though renderer inspection should use **Offline Replay** instead of the live host."

## Flagged ambiguities

- "Active" and "offline replay eligible" are independent classifications: `destroying` is both **Active** and **Offline Replay Eligible**.
