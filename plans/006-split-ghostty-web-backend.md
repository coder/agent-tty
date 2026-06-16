# Plan 006: Extract the harness HTML and harness-decoding layer out of the ghostty-web backend god file

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c11e2e2..HEAD -- src/renderer/ghosttyWeb/backend.ts`
> If `backend.ts` changed since this plan was written, re-locate the symbols by
> name (line numbers below will have shifted) and confirm they still match the
> descriptions before proceeding; on a structural mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (the existing renderer unit + e2e tests are the safety net)
- **Category**: tech-debt
- **Planned at**: commit `c11e2e2`, 2026-06-16

## Why this matters

`src/renderer/ghosttyWeb/backend.ts` is **2814 lines** — by far the largest file
in the repo — and mixes five unrelated concerns in one module: a ~790-line
embedded HTML/JS harness string, the harness-snapshot decoding/validation layer,
generic assertion helpers, a local HTTP server, and the renderer class itself.
That makes it hard to navigate, hard to test in isolation, and hard for an agent
to change safely. This plan removes the two **safe, high-value** chunks — the
embedded harness HTML and the harness-decoding free functions — into sibling
modules, cutting the file roughly in half. It deliberately does **not** touch the
HTTP-server/bridge class methods (which hold `this` state and need a more careful
refactor); those are a separate follow-up. No runtime behavior changes: this is a
pure move-and-reimport.

## Current state

`backend.ts` layout (line numbers approximate — locate by symbol name):

- **48–110**: interfaces. Of these, the _snapshot_ interfaces move; the
  _server/bridge_ interfaces stay (see Scope):
  - move: `GhosttyHarnessVisibleLine` (48), `GhosttyHarnessSnapshotCell` (53),
    `GhosttyHarnessRichLine` (63), `GhosttyHarnessSnapshot` (68).
  - stay (server/bridge concern): `GhosttyRequestAsset` (79),
    `GhosttyServedAsset` (84), `GhosttyBrowserBridge` (88),
    `GhosttyBrowserGlobal` (97).
- **111–138**: constants (`DEFAULT_PAGE_VIEWPORT`, content-type strings,
  `HARNESS_CONTENT_SECURITY_POLICY`, `MAX_REPLAY_BATCH_SIZE`, `RAF_TIMEOUT_MS`) —
  **stay** (server/replay concern).
- **140–929**: `const EMBEDDED_HARNESS_HTML = \`…\`;`— the ~790-line embedded
harness document. **Move (Step 1).** Its only consumer is`loadHarnessHtml`(line 1065:`return EMBEDDED_HARNESS_HTML;`). Two comments (≈942, ≈972)
  reference it by name; they remain accurate after the move.
- **931–1058**: decoding helpers + generic assertions. **Move (Step 2):**
  `GhosttyDecodedColumn` (931, exported), `stripTrailingAsciiSpaces` (945,
  exported), `assembleCanonicalLine` (974, exported), `assertNonNegativeInteger`
  (998), `assertPositiveInteger` (1008), `assertPositiveNumber` (1018),
  `assertHexColor` (1028), `normalizeError` (1036).
- **1061–1419**: harness loaders/validators. **Move (Step 2):** `loadHarnessHtml`
  (1061), `validateHarnessLines` (1169), `validateHarnessSnapshotCells` (1217),
  `validateHarnessSnapshot` (1337).
- **1421–2814**: `export class GhosttyWebBackend` — **stays** (boot, replayTo,
  snapshot, screenshot, video, dispose, and the HTTP server / bridge methods).

**External consumers** (must keep working):

- `test/unit/renderer/ghosttyWebDecode.test.ts:4-7` imports
  `assembleCanonicalLine`, `stripTrailingAsciiSpaces`, and the type
  `GhosttyDecodedColumn` **from `ghosttyWeb/backend.js`**. After the move,
  `backend.ts` must **re-export** these three so this import keeps resolving.
- `src/renderer/libghosttyVt/backend.ts:18` and `src/export/webm.ts:17` import
  the `GhosttyWebBackend` **class** from `backend.js` — the class stays, so these
  are unaffected.

### Conventions to follow

- Strict TS, NodeNext ESM, `.js` import extensions on every relative import,
  `import type` for type-only imports (oxlint enforces `import type`).
- 2-space indent, single quotes, trailing commas, semicolons (oxfmt enforces);
  run the formatter after moves.
- **No circular imports.** The new modules are leaves: `harnessDecoding.ts`
  imports from `embeddedHarnessHtml.ts` and `src/util/*`, never from
  `backend.ts`. `backend.ts` imports from both new modules.

## Commands you will need

| Purpose                   | Command                                    | Expected    |
| ------------------------- | ------------------------------------------ | ----------- |
| Typecheck                 | `npm run typecheck`                        | exit 0      |
| Lint                      | `npm run lint`                             | exit 0      |
| Format (fix)              | `npm run format`                           | exit 0      |
| Decode/backend unit tests | `npx vitest run test/unit/renderer`        | all pass    |
| e2e (visual)              | `npm run test:e2e`                         | all pass    |
| Line count                | `wc -l src/renderer/ghosttyWeb/backend.ts` | ~1500 after |

## Scope

**In scope** (create + modify):

- `src/renderer/ghosttyWeb/embeddedHarnessHtml.ts` (create) — the HTML constant.
- `src/renderer/ghosttyWeb/harnessDecoding.ts` (create) — the snapshot interfaces,
  decode helpers, generic assertion helpers, and validators listed above.
- `src/renderer/ghosttyWeb/backend.ts` (modify) — remove the moved symbols, add
  imports, re-export the three externally-consumed names.

**Out of scope** (do NOT change in this plan):

- The `GhosttyWebBackend` class body and all its methods — especially the HTTP
  server / bridge methods (`startServer`, `respondToRequest`, `buildHarnessUrl`,
  `isAllowedBrowserRequest`, `writeBridge`, `writeBatchBridge`, `resizeBridge`,
  `readHarnessSnapshot`, etc.). Extracting those is a deliberate follow-up.
- The server/bridge interfaces and the `111–138` constants (they belong with the
  server methods that stay).
- Any behavior change. This is a move; logic must be byte-identical.
- `src/renderer/libghosttyVt/backend.ts`, `src/export/webm.ts` (only consume the
  class, which doesn't move).
- `CHANGELOG.md` (automation-owned).

## Git workflow

- Branch: `advisor/006-split-ghostty-web-backend`
- Conventional Commits. Example: `refactor: split harness HTML and decoding out of the ghostty-web backend`.
  One commit per step is fine.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Extract the embedded harness HTML

1. Create `src/renderer/ghosttyWeb/embeddedHarnessHtml.ts` containing the moved
   constant:

   ```ts
   export const EMBEDDED_HARNESS_HTML = `<!doctype html>
   …(the entire current value, verbatim)…`;
   ```

2. Delete the `const EMBEDDED_HARNESS_HTML = …;` block (lines ~140–929) from
   `backend.ts`.
3. In `backend.ts`, add `import { EMBEDDED_HARNESS_HTML } from './embeddedHarnessHtml.js';`
   (with the other relative imports). `loadHarnessHtml` keeps using the name
   unchanged.

**Verify**: `npm run typecheck` → exit 0. `wc -l src/renderer/ghosttyWeb/backend.ts`
→ roughly 2020 lines (down ~790). `npx vitest run test/unit/renderer` → all pass.

### Step 2: Extract the harness-decoding layer

1. Create `src/renderer/ghosttyWeb/harnessDecoding.ts`. Move into it, verbatim,
   these symbols from `backend.ts`:
   - Interfaces: `GhosttyHarnessVisibleLine`, `GhosttyHarnessSnapshotCell`,
     `GhosttyHarnessRichLine`, `GhosttyHarnessSnapshot`.
   - `GhosttyDecodedColumn`, `stripTrailingAsciiSpaces`, `assembleCanonicalLine`.
   - `assertNonNegativeInteger`, `assertPositiveInteger`, `assertPositiveNumber`,
     `assertHexColor`, `normalizeError`.
   - `loadHarnessHtml`, `validateHarnessLines`, `validateHarnessSnapshotCells`,
     `validateHarnessSnapshot`.
   - Keep the existing `export` keyword on whatever was already exported; export
     everything `backend.ts` will need to import back.
2. Add the new module's imports at its top: `EMBEDDED_HARNESS_HTML` from
   `./embeddedHarnessHtml.js`, and `invariant`/`unreachable` (whichever are used)
   from `../../util/assert.js`. Let `npm run typecheck` tell you exactly which
   util symbols and types are needed.
3. In `backend.ts`, delete the moved blocks and add a single import from
   `./harnessDecoding.js` for every moved symbol the class still references
   (the validators, the assertion helpers used in `replayTo`/`screenshot`, etc.).
   Run `npm run typecheck` and add/remove imports until it is clean.

**Verify**: `npm run typecheck` → exit 0; `npx vitest run test/unit/renderer`
→ all pass.

### Step 3: Re-export the externally-consumed names and tidy

1. In `backend.ts`, add a re-export so the existing decode test keeps resolving:

   ```ts
   export {
     assembleCanonicalLine,
     stripTrailingAsciiSpaces,
   } from './harnessDecoding.js';
   export type { GhosttyDecodedColumn } from './harnessDecoding.js';
   ```

   (Do not edit `test/unit/renderer/ghosttyWebDecode.test.ts` — the re-export is
   what keeps its `from '…/backend.js'` import valid.)

2. Run `npm run format`, then `npm run lint` → both exit 0.

**Verify**: `npx vitest run test/unit/renderer/ghosttyWebDecode.test.ts`
→ all pass (proves the re-export works).

### Step 4: Full behavior gate

- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run test:unit` → all pass.
- `npm run test:e2e` → all pass (this exercises the real ghostty-web rendering /
  screenshot path end-to-end; it is the proof the move changed no behavior). If
  e2e cannot run in this environment, say so explicitly.

## Test plan

This is a refactor with **no new behavior**, so the test plan is _regression_:

- `test/unit/renderer/ghosttyWebDecode.test.ts` (decode helpers) — must pass
  unchanged via the re-export.
- `test/unit/renderer/ghosttyWebBackend.test.ts`, `canonicalScreen.test.ts`, and
  the rest of `test/unit/renderer/` — must pass unchanged.
- `npm run test:e2e` — must pass unchanged (visual/screenshot parity).
- No new test files are required. If you find a moved helper had **zero**
  coverage and you want to add a focused unit test for it in
  `test/unit/renderer/`, that's welcome but optional.

## Done criteria

ALL must hold:

- [ ] `src/renderer/ghosttyWeb/embeddedHarnessHtml.ts` and
      `src/renderer/ghosttyWeb/harnessDecoding.ts` exist.
- [ ] `grep -n "EMBEDDED_HARNESS_HTML = " src/renderer/ghosttyWeb/backend.ts`
      → no match (constant moved out).
- [ ] `wc -l src/renderer/ghosttyWeb/backend.ts` → roughly 1500 lines (down from 2814).
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` all exit 0.
- [ ] `npm run test:unit` exits 0, including `test/unit/renderer/ghosttyWebDecode.test.ts`
      (proves the re-export).
- [ ] `npm run test:e2e` passes (or its inability to run here is reported).
- [ ] `git diff` shows only moves/imports/re-exports — no logic edits inside any
      moved function, no change to the `GhosttyWebBackend` class methods.
- [ ] No `CHANGELOG.md` change; no out-of-scope files modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Moving a symbol creates a circular import that typecheck flags
  (`harnessDecoding.ts` must never import from `backend.ts`). If a moved function
  genuinely depends on something only the class has, leave that function in
  `backend.ts` and report it.
- Any `test/unit/renderer/*` or e2e test fails after a move — that means a move
  was not behavior-preserving (likely a missed import or an accidental edit).
  Do not change the test; find the move error or report it.
- The `GhosttyWebBackend` class needs edits beyond import lines to compile — that
  signals you've moved something that should have stayed; report it.
- `backend.ts` does not end up substantially smaller (e.g. still > 1800 lines) —
  re-check that both Step 1 and Step 2 actually removed their blocks.

## Maintenance notes

- **Deferred to a follow-up plan**: extracting the HTTP server + browser-bridge
  methods (`startServer`, `respondToRequest`, asset serving, `buildHarnessUrl`,
  `isAllowedBrowserRequest`, the `*Bridge` methods) into a `server.ts` / a bridge
  helper. Those touch `this` (the `server`, `serverOrigin`, `page` fields), so
  they need dependency extraction or a small server class — higher risk, separate
  change. This plan intentionally stops before that.
- A reviewer should confirm the diff is move-only: no function body changed, and
  the re-exports preserve the public import surface (`ghosttyWebDecode.test.ts`
  and any other importer of the three decode symbols still resolve).
- The two in-code comments that mention `EMBEDDED_HARNESS_HTML` (the canonical-line
  helpers note they must stay in sync with the harness copy) remain correct and
  should be left as-is.
