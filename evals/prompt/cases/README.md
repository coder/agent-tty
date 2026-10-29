# evals/prompt/cases

## Overview

This directory defines the 24 prompt-lane eval cases in four arrays. Each case is a plan-mode question with expected and forbidden answer patterns and workflow checks. Most cases are literal objects passed through a local `parseCase`, which calls `PromptEvalCaseSchema.parse` from `evals/lib/schemas.ts`. `evals/prompt/runner.ts` imports all four arrays.

## Interface

- `TRIGGER_AGENT_TTY_PROMPT_CASES` holds 8 cases with category `trigger` and expected skill `agent-tty`. Seven are literal objects. `wait-for-output` is built with `promptCase(...).build()` from `evals/authoring/index.ts`. [trigger-agent-tty.ts:TRIGGER_AGENT_TTY_PROMPT_CASES] [trigger-agent-tty.ts:waitForOutputCase]
- `TRIGGER_DOGFOOD_TUI_PROMPT_CASES` holds 6 cases with category `trigger` and expected skill `dogfood-tui`. [trigger-dogfood-tui.ts:TRIGGER_DOGFOOD_TUI_PROMPT_CASES]
- `SHOULD_NOT_TRIGGER_PROMPT_CASES` holds 6 cases with category `trigger` and expected skill `none`. [should-not-trigger.ts:SHOULD_NOT_TRIGGER_PROMPT_CASES]
- `ANTI_PATTERN_PROMPT_CASES` holds 4 cases with category `anti-pattern` and expected skill `agent-tty` (`blind-sleep`, `tmux-usage`, `screen-usage`, `adhoc-screenshots`). [anti-patterns.ts:ANTI_PATTERN_PROMPT_CASES]
- Each file has local, non-exported `parseCase`, `requiredCheck`, `PROMPT_TIMEOUT_MS` and `EMPTY_ANTI_PATTERNS`. [anti-patterns.ts:parseCase] [anti-patterns.ts:requiredCheck]

## Invariants

- Each literal case must pass `PromptEvalCaseSchema.parse`. An invalid case throws when the module loads. [anti-patterns.ts:parseCase] [trigger-agent-tty.ts:parseCase]
- The façade case must pass `PromptCaseBuilder.build()` in `evals/authoring/prompt.ts`. [trigger-agent-tty.ts:waitForOutputCase]
- Each array is typed `PromptEvalCase[]` from `evals/lib/types.ts`. [should-not-trigger.ts:SHOULD_NOT_TRIGGER_PROMPT_CASES]
- `requiredCheck` returns a workflow check with `required: true` and `dependsOn: []`. [trigger-dogfood-tui.ts:requiredCheck]
- Every case uses `PROMPT_TIMEOUT_MS = 30_000` and an empty anti-pattern list. [trigger-agent-tty.ts:PROMPT_TIMEOUT_MS] [trigger-agent-tty.ts:EMPTY_ANTI_PATTERNS]

## Side Effects

- None found in code. Schema validation and the façade `build()` run at import time. [anti-patterns.ts:parseCase] [trigger-agent-tty.ts:waitForOutputCase]

## Verification

- Run: `npx vitest run test/unit/evals/authoring/parity.test.ts test/unit/evals/promptRunner.test.ts`
- Integration: `npx vitest run --maxWorkers=1 test/integration/evals/authoring-pilots.test.ts`
- Run: `npm run typecheck`
