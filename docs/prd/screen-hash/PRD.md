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
7. As a caller, I want the hash present whenever a result holds an **observed** **Semantic Snapshot** — including the offline host-unreachable `matched: false` fallback that still observed a snapshot — and omitted only when no snapshot was observed (a live timeout, a consecutive-failure giveup, or a replay error), so that a missing hash unambiguously means "no screen was observed" rather than signalling an error.
8. As a tooling author, I want the **Screen Hash** to be renderer-independent — the same screen yields the same hash under either renderer backend — so that I can compare hashes across sessions rendered by different backends.
9. As a maintainer, I want the **Screen Hash**, the **Screen Stability** compare, and text **Render Wait** matching to share one canonical visible-text definition, so that they can never disagree about what "the screen" is.
10. As a maintainer, I want adding the **Screen Hash** and routing the three consumers through one shared canonical-text definition to make no change in itself to the shipped screen-stability behavior, so that the only behavior change is the deliberate, characterization-pinned Phase 1 renderer convergence — not an accidental side effect of the hash.
11. As a caller, I want to understand that the **Screen Hash** is distinct from a screenshot's pixel digest, so that I use the right identity for content versus pixels.
12. As a caller, I want to understand that the **Screen Hash** covers the visible screen only, even though the text snapshot format also includes scrollback, so that I am not surprised that the hash ignores scrollback growth.
13. As a tool building recordings, I want a per-frame content hash, so that I can dedup consecutive identical frames in artifacts.
14. As a caller using `--json`, I want the hash as a lowercase 64-character hex string validated by the same digest schema as other hashes, so that the field shape is predictable.
15. As a caller, I want the **Screen Hash** to be optional on results, so that older artifacts and hosts that predate it still parse.

## Implementation Decisions

- Add an optional **Screen Hash** field — a lowercase 64-character SHA-256 hex digest — to the snapshot result (both structured and text formats) and to the matched render-wait result.
- In scope: a **Batch Step** record for a matched **Render Wait** step also carries the **Screen Hash**, mirrored from that step's render-wait result, so a batch run exposes the same content identity per wait step that a standalone wait does.
- The **Screen Hash** is the SHA-256 of the canonical visible-text string: the visible lines joined by newline, exactly as the host's screen-stability compare and the text matcher already build it. The shared canonical-text **definition** — `visibleLines[].text` joined by `\n`, sourced only from the snapshot (never `backend.getVisibleText()` or `cells[]`) — is unchanged by adding the hash. Cursor position, text styles, and scrollback are excluded.
- Converging the two renderer backends on one canonical screen form (Phase 1) intentionally changed the then-default `ghostty-web` backend's stability and text-wait **comparand** on screens with grapheme clusters, interior blank-cell gaps, or non-ASCII trailing characters: the canonical form is exactly `rows` lines, each decoded with full grapheme clusters with blank/zero cells as `' '`, then right-trimmed of trailing ASCII spaces (`0x20`) only. This was a deliberate, narrow change pinned by characterization tests, not a free behavior-preserving add; on plain ASCII screens the comparand was unchanged.
- Extract one shared canonical-screen-text helper and route the **Screen Hash**, the host **Screen Stability** compare, and the text **Render Wait** matcher through it, so the three share a single definition and cannot diverge.
- The hash is keyed on whether a result holds an **observed** **Semantic Snapshot**, not on whether the wait matched. A result carries the **Screen Hash** of the snapshot it observed: a matched live wait, a snapshot capture, and the offline host-unreachable fallback that still observed a latest snapshot (even when it returns `matched: false` because the **Screen Stability** duration could not be proven offline). The hash is omitted only when no snapshot was observed: a live wait that times out, a consecutive-failure giveup, or a replay error throw.
- Do not surface the **Screen Hash** on inspection or any path that does not already render a **Semantic Snapshot**; computing it must never force a renderer bootstrap that would not otherwise happen.
- Reuse the existing SHA-256 hex validator. The consolidation set is exactly: export `Sha256HexSchema` from `protocol/schemas.ts` and import it in `renderer/types.ts`. Deliberately left out of scope: the standalone regex copies in `storage/artifactManifest.ts` and the `invariant(/^[a-f0-9]{64}$/u.test(...))` checks (for example in `renderer/profiles.ts` and `renderer/bundledFont.ts`), which are not Zod schemas and are not part of this consolidation.
- The field is optional so existing persisted artifacts and older hosts continue to parse.

## Testing Decisions

Good tests assert external behavior, not implementation details.

- **Canonical-text and hash helper (unit).** Same screen yields the same hash; cursor-only movement yields the same hash; a single visible-glyph change yields a different hash; a trailing-whitespace-only difference (before right-trim of ASCII spaces) yields a different hash — proving the canonical form is exactly what is hashed and the behavior is as specified.
- **UTF-8 encoding pinned (unit).** The hash is the SHA-256 of the UTF-8 bytes of the canonical visible text, asserted against a concrete golden digest so the encoding can never silently drift. Golden: a three-row screen whose canonical text is `"a\nb\nc"` hashes to `ea7fb08b7a2dc4619ffb7c7bb38d95a2047935fa165d71b12efd3852a2e6d0cc`.
- **Shared definition (unit).** The host **Screen Stability** compare and the **Render Wait** matcher consume the same canonical string the hash uses, so a later change to one cannot silently diverge from the others, and screen-stability behavior is demonstrably unchanged.
- **Cross-backend hash equality.** The same event log produces the same **Screen Hash** under both renderer backends, pinning the renderer-independence guarantee that is currently only an assumption. This test requires the optional native addon (`@coder/libghostty-vt-node`) and so must run on at least one CI job that has the addon installed; it skips gracefully where the addon is absent (including the sandbox), so the renderer-independence guarantee is not silently unverified.
- **Snapshot and wait envelope (integration).** Against an isolated home: the **Screen Hash** is present on a snapshot (structured and text), on a matched live wait, and on the offline host-unreachable `matched: false` fallback that still observed a snapshot; and absent on a timed-out live wait. The existing CLI integration tests are prior art.

## Out of Scope

- Per-frame **Screen Hash**es on recordings / `record export` (user story 13). v1 attaches the hash only where a result already holds an observed **Semantic Snapshot**; the export paths render no **Semantic Snapshot** per frame, so a recording-frame dedup hash is future scope rather than a v1 deliverable.
- A scrollback hash. The **Screen Hash** is visible-screen-only; a separate scrollback digest can be added later if a concrete need appears.
- A styled or per-cell hash. Transient style churn would make such a hash flap; the **Screen Hash** is text-content identity only.
- Pixel-level identity, and any **Screen Hash** on the **Screenshot Result**. A **Screenshot Result** carries only its pixel `sha256`; the content hash lives on the snapshot and wait results. The **Screen Hash** is the semantic counterpart to the pixel digest and the two are not interchangeable.
- New wait semantics built on the hash (for example, "wait until the screen content changes"). v1 only exposes the field; any hash-driven wait is future scope.
- Any change to the screen-stability behavior **beyond** the Phase 1 renderer-convergence change described in the Implementation Decisions. The canonical-text definition and the shared single-source unify are behavior-preserving; the only intended behavior change was the then-default `ghostty-web` backend's comparand on grapheme / interior-gap / non-ASCII-trailing screens, pinned by characterization tests. No new wait semantics are added.

## Further Notes

- The motivation differs from the comparable tool virtui, which hashes to avoid shipping screen bytes over a socket. agent-tty is a local CLI, so the value here is the stable content change-token and frame dedup, not transfer avoidance.
- The **Screen Hash** term is defined in the project glossary; this PRD and that term are on branch `feat/screen-hash`. No ADR was needed: the field is an optional add over the canonical string that already exists, and the one intended behavior change — the Phase 1 renderer convergence — is narrow, characterization-pinned, and easily reversible.
