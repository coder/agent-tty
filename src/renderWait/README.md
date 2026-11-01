# src/renderWait

## Overview

This directory validates render-wait conditions and matches them against semantic snapshots. `prepareRenderWaitCondition` checks a `waitForRender` condition from user input and compiles its regex once. `matchRenderWaitSnapshot` reports whether a snapshot satisfies the text, cursor, stability and baseline parts of the condition. `limits.ts` holds the length limits that `src/protocol/schemas.ts` also uses. Callers include `src/cli/commands/wait.ts`, `src/host/hostMain.ts` and `src/batch/plan.ts`.

## Interface

- `MAX_WAIT_FOR_RENDER_TEXT_LENGTH` (1000), `MAX_WAIT_FOR_RENDER_REGEX_LENGTH` (200) and `MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH` (50,000) [limits.ts:MAX_WAIT_FOR_RENDER_TEXT_LENGTH]. `matcher.ts` re-exports all three.
- `PreparedRenderWaitCondition`: the `text`, `regex`, `scope`, `screenStableMs`, `cursorRow`, `cursorCol` and `afterSeq` fields of `WaitForRenderParams` from `src/protocol/messages.ts`, plus an optional `compiledRegex` [matcher.ts:PreparedRenderWaitCondition].
- `prepareRenderWaitCondition(condition)` validates the condition and returns a `PreparedRenderWaitCondition` [matcher.ts:prepareRenderWaitCondition].
- `matchRenderWaitSnapshot(condition, snapshot, options?)` returns `matched` plus the per-part results `textMatched`, `cursorMatched`, `stabilityMatched` and `baselineMatched`, plus `contentAndCursorMatched`, the matched text, the cursor, `capturedAtSeq` and the canonical `visibleLines` [matcher.ts:matchRenderWaitSnapshot]. `contentAndCursorMatched` lets the offline fallback in `src/cli/commands/wait.ts` tell a stability result it cannot prove from a mismatch.
- `hasNestedQuantifiers(pattern)` detects a quantified group that already contains a quantifier [matcher.ts:hasNestedQuantifiers].
- `safeRegexExec(regex, text)` runs `regex.exec` on text cut to `MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH` characters [matcher.ts:safeRegexExec].

## Invariants

- `prepareRenderWaitCondition` throws an `INVALID_INPUT` CLI error when a rule fails [matcher.ts:prepareRenderWaitCondition]:
  - The condition needs at least one of `text`, `regex`, `screenStableMs`, `cursorRow` or `cursorCol`. `afterSeq` alone is not enough.
  - `text` and `regex` cannot both be set. Scope `cursor-line` needs `text` or `regex`.
  - `text` length must be 1 to 1000. `regex` length must be 1 to 200.
  - A regex with nested quantifiers or an invalid pattern is rejected.
  - `screenStableMs` must be a positive integer. `cursorRow`, `cursorCol` and `afterSeq` must be non-negative integers.
- The compiled regex has no flags [matcher.ts:prepareRenderWaitCondition].
- `matchRenderWaitSnapshot` asserts with `invariant` that a regex condition carries `compiledRegex` and that it is not global or sticky. It also asserts non-negative integer cursor and `capturedAtSeq` values [matcher.ts:matchRenderWaitSnapshot].
- Text matching is a substring check on the canonical visible text, or on the cursor row for scope `cursor-line` [matcher.ts:matchRenderWaitSnapshot].
- A snapshot meets the baseline only when `capturedAtSeq > afterSeq` [matcher.ts:matchRenderWaitSnapshot].
- With `screenStableMs` set and no `stableForMs` option, `stabilityMatched` is false [matcher.ts:matchRenderWaitSnapshot].

## Side Effects

- None found in code.

## Verification

- Run: `npx vitest run test/unit/renderWait`
- Run: `npm run typecheck`
