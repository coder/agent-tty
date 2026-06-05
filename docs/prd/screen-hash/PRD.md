# PRD: Screen Hash on snapshot and wait results

## Problem Statement

A caller — often an AI coding agent — driving a **Session** repeatedly needs a cheap, reliable way to answer "did the rendered screen actually change since I last looked?" Today the only per-result identifier is the captured event-log sequence, but that advances on every chunk of output, including output that changes nothing visible: cursor-position queries, terminal-mode toggles, a spinner repainting the same glyphs. So two observations with different sequences can be the identical screen, and a caller comparing sequences sees changes that are not there. There is no stable token for the screen's content itself.

## Solution

Snapshot results and matched **Render Wait** results gain an optional **Screen Hash**: a stable digest of the **Session**'s normalized visible screen text at the captured event-log sequence. Equal hashes mean the visible content is identical; a changed hash means it genuinely changed. The **Screen Hash** is computed from the same canonical visible text that the **Screen Stability** check and text **Render Wait** matching already use, so "the hash changed" and "the stability check saw a change" can never disagree.

## User Stories

1. As an AI coding agent, I want a stable hash of the screen content on each snapshot, so that I can tell across two CLI calls whether the visible screen actually changed without diffing full text myself.
2. As an agent, I want the hash to stay equal when only the cursor moved, so that cursor motion alone does not look like a content change.
3. As an agent, I want the hash to stay equal when output occurred that changed nothing visible, so that I am not misled by the captured sequence advancing on a no-op repaint.
4. As an agent, I want the hash to change whenever the visible text changes, so that I can trust it as a content-changed signal.
5. As a caller, I want the **Screen Hash** on the snapshot result in both structured and text formats, so that I get it regardless of how I read the screen.
6. As a caller, I want the **Screen Hash** on a matched render-wait result, so that I know the content identity at the moment my wait condition was satisfied.
7. As a caller, I want a render wait that times out or finds the host unreachable to simply omit the hash, so that a missing hash unambiguously means "no screen was observed" rather than signalling an error.
8. As a tooling author, I want the **Screen Hash** to be renderer-independent — the same screen yields the same hash under either renderer backend — so that I can compare hashes across sessions rendered by different backends.
9. As a maintainer, I want the **Screen Hash**, the **Screen Stability** compare, and text **Render Wait** matching to share one canonical visible-text definition, so that they can never disagree about what "the screen" is.
10. As a maintainer, I want adding the **Screen Hash** to make no change to the shipped screen-stability behavior, so that existing waits behave exactly as before.
11. As a caller, I want to understand that the **Screen Hash** is distinct from a screenshot's pixel digest, so that I use the right identity for content versus pixels.
12. As a caller, I want to understand that the **Screen Hash** covers the visible screen only, even though the text snapshot format also includes scrollback, so that I am not surprised that the hash ignores scrollback growth.
13. As a tool building recordings, I want a per-frame content hash, so that I can dedup consecutive identical frames in artifacts.
14. As a caller using `--json`, I want the hash as a lowercase 64-character hex string validated by the same digest schema as other hashes, so that the field shape is predictable.
15. As a caller, I want the **Screen Hash** to be optional on results, so that older artifacts and hosts that predate it still parse.

## Implementation Decisions

- Add an optional **Screen Hash** field — a lowercase 64-character SHA-256 hex digest — to the snapshot result (both structured and text formats) and to the matched render-wait result.
- The **Screen Hash** is the SHA-256 of the canonical visible-text string: the visible lines joined by newline, exactly as the host's screen-stability compare and the text matcher already build it. Trailing whitespace is kept (no new normalization), so adding the hash makes zero change to the shipped screen-stability behavior. Cursor position, text styles, and scrollback are excluded.
- Extract one shared canonical-screen-text helper and route the **Screen Hash**, the host **Screen Stability** compare, and the text **Render Wait** matcher through it, so the three share a single definition and cannot diverge.
- A render wait that times out or finds the host unreachable carries no **Screen Hash**, because there is no observed **Semantic Snapshot** to hash. On a matched wait, the hash is that of the matched snapshot.
- Do not surface the **Screen Hash** on inspection or any path that does not already render a **Semantic Snapshot**; computing it must never force a renderer bootstrap that would not otherwise happen.
- Reuse the existing SHA-256 hex validator, consolidating its duplicate definitions into one.
- The field is optional so existing persisted artifacts and older hosts continue to parse.

## Testing Decisions

Good tests assert external behavior, not implementation details.

- **Canonical-text and hash helper (unit).** Same screen yields the same hash; cursor-only movement yields the same hash; a single visible-glyph change yields a different hash; a trailing-whitespace-only difference yields a different hash — proving trailing whitespace is intentionally retained and the behavior is unchanged.
- **Shared definition (unit).** The host **Screen Stability** compare and the **Render Wait** matcher consume the same canonical string the hash uses, so a later change to one cannot silently diverge from the others, and screen-stability behavior is demonstrably unchanged.
- **Cross-backend hash equality.** The same event log produces the same **Screen Hash** under both renderer backends, pinning the renderer-independence guarantee that is currently only an assumption.
- **Snapshot and wait envelope (integration).** Against an isolated home: the **Screen Hash** is present on a snapshot (structured and text) and on a matched wait, and absent on a timed-out wait. The existing CLI integration tests are prior art.

## Out of Scope

- A scrollback hash. The **Screen Hash** is visible-screen-only; a separate scrollback digest can be added later if a concrete need appears.
- A styled or per-cell hash. Transient style churn would make such a hash flap; the **Screen Hash** is text-content identity only.
- Pixel-level identity. That is already served by the screenshot pixel digest; the **Screen Hash** is its semantic counterpart and the two are not interchangeable.
- New wait semantics built on the hash (for example, "wait until the screen content changes"). v1 only exposes the field; any hash-driven wait is future scope.
- Any change to the screen-stability behavior. The unify is deliberately behavior-preserving.

## Further Notes

- The motivation differs from the comparable tool virtui, which hashes to avoid shipping screen bytes over a socket. agent-tty is a local CLI, so the value here is the stable content change-token and frame dedup, not transfer avoidance.
- The **Screen Hash** term is defined in the project glossary; this PRD and that term are on branch `feat/screen-hash`. No ADR was needed: the design is behavior-preserving and easily reversible — an optional field over the canonical string that already exists.
