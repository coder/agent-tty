# evals/dogfood

## Overview

This directory is Lane C (dogfood) of the eval harness. `runner.ts` turns the dogfood cases into work items (case × skill condition × trial) and runs each item as an agent-mode provider call in a temporary home. It then scores the proof bundle and report and returns schema-checked `EvalResult` objects. See `evals/README.md` for the lane design.

## Interface

- [cases/README.md](./cases/README.md): the six `DogfoodEvalCase` definitions and `dogfoodTaskPrompt`.
- [scorers/README.md](./scorers/README.md): `scoreDogfoodRun` and the report text scorers.
- `getAllDogfoodCases()` returns a copy of the six validated cases in `DOGFOOD_CASES`. [runner.ts:getAllDogfoodCases] [runner.ts:DOGFOOD_CASES]
- `enumerateDogfoodWorkItems(options?)` returns one work item per case × supported condition × trial, filtered by `conditions` and `caseFilter`. [runner.ts:enumerateDogfoodWorkItems]
- `executeDogfoodWorkItem(provider, metadata, workItem, ctx)` runs one trial and returns `Promise<EvalResult>`. A thrown error becomes a failed result with a zero score. [runner.ts:executeDogfoodWorkItem]
- `runDogfoodLane(provider, metadata, options?)` runs all work items through `runScheduled` from `evals/lib/scheduler.ts` and returns `Promise<EvalResult[]>`. `concurrency` defaults to 1. [runner.ts:runDogfoodLane]

## Invariants

- Every case passes `DogfoodEvalCaseSchema.parse` (from `evals/lib/schemas.ts`) when the module loads. [runner.ts:coerceDogfoodCase]
- The inventory must hold exactly 6 cases: 1 `qa`, 1 `release-readiness`, 3 `bug-repro`, 1 `reporting`. [runner.ts:buildCaseInventory]
- Requested conditions must be in `SKILL_CONDITIONS` and must not repeat. Case filter ids must be known and must not repeat. [runner.ts:validateConditionList] [runner.ts:validateCaseFilter]
- `totalTrials` defaults to 1 and must be a positive integer. Work item keys must be unique (`assertUniqueWorkItems` from `evals/lib/types.ts`). [runner.ts:resolveTotalTrials] [runner.ts:enumerateDogfoodWorkItems]
- A trial passes only if the provider call succeeded, no anti-pattern finding has severity `error`, no report section is missing, every workflow check passed, and `overallScore >= 0.6`. [runner.ts:executeDogfoodWorkItem]
- Results pass `EvalResultSchema.parse` from `evals/lib/schemas.ts`. [runner.ts:executeDogfoodWorkItem]
- The score breakdown has five items of max 0.2 each. [runner.ts:buildDogfoodBreakdownItems]

## Side Effects

- Reads `skills/agent-tty/SKILL.md`, `skill-data/agent-tty/SKILL.md` and `skill-data/dogfood-tui/SKILL.md` with `readFile` and caches them for the module. [runner.ts:loadDogfoodSkillPrompts]
- Creates `<tmpdir>/agent-tty-evals/<runId>/<provider>/<case>/<condition>/trial-N` and its `agent-tty-home` with `mkdir`. Removes both with `rm({ recursive: true, force: true })` in a `finally` block. [runner.ts:buildRequestedPaths] [runner.ts:executeDogfoodWorkItem]
- Calls `provider.invokeAgentMode` with `AGENT_TTY_HOME`, `EVAL_OUTPUT_DIR`, `EVAL_REQUESTED_BUNDLE_DIR`, `EVAL_FIXTURE` and the `EVAL_SKILL_CONDITION`/`EVAL_SYSTEM_PROMPT` variables in the request env. The `self-load`, `preloaded` and `stale` conditions also set `EVAL_PRELOADED_SKILL_NAME`. For a case with a workspace, the request env is the preset's `effectiveEnv` plus `AGENT_TTY_HOME` instead. [runner.ts:executeDogfoodWorkItem] [runner.ts:buildSystemPromptContext] [runner.ts:resolveDogfoodWorkspace]
- Calls `provider.detect()` once per lane and uses a fallback runtime if it fails. [runner.ts:runDogfoodLane]
- Prepares preset workspaces through `evals/workspaces/registry.ts`, `evals/workspaces/resolver.ts` and `materializeEvalWorkspace` in `evals/lib/cliHarness.ts`. [runner.ts:resolveDogfoodWorkspace]
- Reads report notes, the transcript and bundle files for scoring (`readFile`, `stat`, `scanBundleArtifacts` from `src/tools/review-bundle.ts`). [runner.ts:resolveReportText] [runner.ts:pathExists]
- Writes token usage files through `writeTokenUsageArtifact` from `evals/lib/artifacts.ts`. [runner.ts:writeDogfoodTokenUsageArtifacts]
- Sends `laneStart`, `trialStart`, `trialFinish` and `laneFinish` events to the reporter when one is given. It also sends `caseStart` and `caseFinish` through `CaseProgressTracker` from `evals/reporters/runtime.ts`. [runner.ts:runDogfoodLane] [../reporters/runtime.ts:CaseProgressTracker]

## Verification

- Run: `npx vitest run test/unit/evals/dogfoodRunner.test.ts test/unit/evals/authoring/parity.test.ts`
- Integration: `npx vitest run --maxWorkers=1 test/integration/evals/authoring-pilots.test.ts`
- Run: `npm run typecheck`
