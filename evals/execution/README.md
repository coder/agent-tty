# evals/execution

## Overview

This directory is Lane B (execution) of the eval harness. `runner.ts` turns the ten execution cases into work items (case × skill condition × trial) and runs each item as an agent-mode provider call with an isolated agent-tty home. It then runs the case verifiers and artifact checks, scores the trial, and returns schema-checked `EvalResult` objects. See `evals/README.md` for the lane design.

## Interface

- [cases/README.md](./cases/README.md): the ten `ExecutionEvalCase` definitions, readiness metadata and case helpers.
- [verifiers/README.md](./verifiers/README.md): `verify` and the verifier functions.
- `getAllExecutionCases()` checks the case inventory and returns a copy of `EXECUTION_CASES`. [runner.ts:getAllExecutionCases] [runner.ts:EXECUTION_CASES]
- `enumerateExecutionWorkItems(options?)` returns one work item per case × supported condition × trial, filtered by `conditions` and `caseFilter`. [runner.ts:enumerateExecutionWorkItems]
- `executeExecutionWorkItem(provider, metadata, workItem, runtime)` runs one trial and returns `Promise<EvalResult>`. [runner.ts:executeExecutionWorkItem]
- `runExecutionLane(provider, metadata, options?)` runs all work items through `runScheduled` from `evals/lib/scheduler.ts` and returns `Promise<EvalResult[]>`. `concurrency` defaults to 1. A rejected item becomes a failed result. [runner.ts:runExecutionLane]

## Invariants

- At module load the inventory must hold exactly 10 cases with unique ids and the category counts in `CASE_CATEGORY_EXPECTATIONS` (session 2, tui 3, artifact 4, recovery 1). [runner.ts:assertExecutionCaseInventory] [runner.ts:CASE_CATEGORY_EXPECTATIONS]
- Every case id must have an entry in `EXECUTION_CASE_COVERAGE`, and every entry must name a registered case. [runner.ts:assertExecutionCaseCoverageMetadata]
- Case filter ids must be known. Work item keys must be unique (`assertUniqueWorkItems` from `evals/lib/types.ts`). [runner.ts:enumerateExecutionWorkItems]
- `totalTrials` defaults to 1 and must be a positive integer. The work item trial must be a positive integer. [runner.ts:resolveTotalTrials] [runner.ts:executeExecutionWorkItem]
- A trial passes when the provider call succeeded, every required verifier passed, and no anti-pattern finding has severity `error`. Workflow checks and artifact requirements are scored but do not gate the pass. [runner.ts:buildScoreBreakdown]
- When a case has `rendererRequirement: 'required'` and the transcript or provider error matches a renderer failure pattern, a failed result gets `errorClass: 'environment-blocked'`. [runner.ts:detectRendererEnvironmentBlock] [runner.ts:ENVIRONMENT_BLOCKED_ERROR_CLASS]
- Results pass `EvalResultSchema.parse` from `evals/lib/schemas.ts`. [runner.ts:buildResult]

## Side Effects

- Reads `skills/agent-tty/SKILL.md` and `skill-data/agent-tty/SKILL.md` with `readFile` and caches them for the module. [runner.ts:loadExecutionSkillPrompts]
- Creates an isolated home with `createIsolatedEvalHome` and an output directory with `mkdtemp` (prefix `agent-tty-execution-eval-`). In a `finally` block it calls `cleanupEvalHome` and `rm({ recursive: true, force: true })`. [runner.ts:runSingleExecutionCase] [runner.ts:RUNNER_OUTPUT_PREFIX]
- Calls `provider.invokeAgentMode` with `AGENT_TTY_HOME` and `AGENT_TTY_EVAL_OUTPUT_DIR` in the request env. It skips the call when `detect()` reports the provider unavailable. The trial then fails with `errorClass: 'provider-unavailable'`, and the placeholder transcript, stdout and stderr files are still written. [runner.ts:runSingleExecutionCase] [runner.ts:createEvalRequest]
- Calls `provider.detect()` once per lane and ignores its errors. [runner.ts:detectRuntime]
- Prepares preset workspaces through `evals/workspaces/registry.ts`, `evals/workspaces/resolver.ts` and `materializeEvalWorkspace` in `evals/lib/cliHarness.ts`. [runner.ts:resolveExecutionWorkspace]
- Writes `transcript.txt`, `stdout.txt` and `stderr.txt` into the output directory, and walks artifact paths with `stat` and `readdir`. [runner.ts:persistRunnerArtifacts] [runner.ts:collectArtifacts]
- Writes token usage files through `writeTokenUsageArtifact` from `evals/lib/artifacts.ts`. [runner.ts:writeExecutionTokenUsageArtifacts]
- Sends `laneStart`, `trialStart`, `trialFinish` and `laneFinish` events to the reporter when one is given. It also sends `caseStart` and `caseFinish` through `CaseProgressTracker` from `evals/reporters/runtime.ts`. [runner.ts:runExecutionLane] [../reporters/runtime.ts:CaseProgressTracker]

## Verification

- Run: `npx vitest run test/unit/evals/executionRunner.test.ts test/unit/evals/verifiers.test.ts test/unit/evals/authoring/parity.test.ts`
- Integration: `npx vitest run --maxWorkers=1 test/integration/evals/authoring-pilots.test.ts`
- Run: `npm run typecheck`
