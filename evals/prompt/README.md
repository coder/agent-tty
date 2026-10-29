# evals/prompt

## Overview

This directory is Lane A (prompt) of the eval harness. `runner.ts` turns the 24 prompt cases into work items (case × skill condition × trial) and sends each item to the provider in plan mode with a condition-specific system prompt. It scores the answer with `scorePromptCase` from `evals/lib/scoring.ts` plus anti-pattern detection, and returns schema-checked `EvalResult` objects. See `evals/README.md` for the lane design.

## Interface

- [cases/README.md](./cases/README.md): the four `PromptEvalCase[]` arrays.
- `getAllPromptCases()` concatenates the trigger-agent-tty, trigger-dogfood-tui, should-not-trigger and anti-pattern arrays and returns validated copies. [runner.ts:getAllPromptCases]
- `enumeratePromptWorkItems(metadata, options?)` validates run metadata and returns `Promise<PromptWorkItem[]>`, one per case × condition × trial. [runner.ts:enumeratePromptWorkItems]
- `executePromptWorkItem(provider, metadata, workItem)` calls the provider and returns `Promise<EvalResult>`. A provider error becomes a failed result. [runner.ts:executePromptWorkItem]
- `runPromptLane(provider, metadata, options?)` runs all work items through `runScheduled` from `evals/lib/scheduler.ts` and returns `Promise<EvalResult[]>`. `concurrency` defaults to 1. [runner.ts:runPromptLane]

## Invariants

- The lane must define exactly `EXPECTED_PROMPT_CASE_COUNT` (24) cases with unique ids. [runner.ts:getAllPromptCases] [runner.ts:EXPECTED_PROMPT_CASE_COUNT]
- Each copied case passes `PromptEvalCaseSchema.parse` from `evals/lib/schemas.ts`. [runner.ts:clonePromptCase]
- Run metadata must pass `RunMetadataSchema.parse`, include the `prompt` lane, and have `totalTrials > 0`. [runner.ts:validatePromptRunMetadata]
- The provider id must be in `metadata.providers`. [runner.ts:assertPromptProviderMetadata]
- Requested conditions must be in `SKILL_CONDITIONS`, must not repeat, and must be in `metadata.conditions` when that list is non-empty. Case filter ids must be known and must not repeat. [runner.ts:resolveRequestedConditions] [runner.ts:resolveRequestedCases]
- A trial passes when the provider call succeeded, `scorePromptCase` passed, and no anti-pattern finding has severity `error`. [runner.ts:buildEvalResult] [runner.ts:hasBlockingAntiPattern]
- Requests pass `ProviderPromptRequestSchema.parse`. Results pass `EvalResultSchema.parse`. Both schemas come from `evals/lib/schemas.ts`. [runner.ts:buildPromptRequest] [runner.ts:buildEvalResult]

## Side Effects

- Reads `skills/agent-tty/SKILL.md`, `skill-data/agent-tty/SKILL.md` and `skill-data/dogfood-tui/SKILL.md` with `readFile` and caches them for the module. [runner.ts:loadSkillPrompts]
- Calls `provider.invokePlanMode`. [runner.ts:executePromptWorkItem]
- Writes token usage files through `writeTokenUsageArtifact` from `evals/lib/artifacts.ts`. [runner.ts:writePromptTokenUsageArtifacts]
- Sends `laneStart`, `trialStart`, `trialFinish` and `laneFinish` events to the reporter when one is given. It also sends `caseStart` and `caseFinish` through `CaseProgressTracker` from `evals/reporters/runtime.ts`. [runner.ts:runPromptLane] [../reporters/runtime.ts:CaseProgressTracker]
- Creates no temporary directories and reads no environment variables.

## Verification

- Run: `npx vitest run test/unit/evals/promptRunner.test.ts test/unit/evals/authoring/parity.test.ts`
- Run: `npm run typecheck`
