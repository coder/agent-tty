# evals/authoring

## Overview

This directory holds the fluent authoring façade for eval cases. Each builder collects case fields, deep-copies nested values, and validates the compiled object against the lane schema in `evals/lib/schemas.ts`. The builders are pure in-memory code. Some case modules under `evals/prompt/cases`, `evals/execution/cases` and `evals/dogfood/cases` call them at import time.

## Interface

- `index.ts` is the public façade. It re-exports the builders below and the `raw*` helpers. It does not re-export `compile.ts`, `WorkflowBuilderOptions`, or the pattern re-exports at the end of `execution.ts`. [index.ts]
- `promptCase(id)` and `PromptCaseBuilder` build a `PromptEvalCase` (setters for category, prompt, expected skill, expected and forbidden patterns, rubric, workflow, anti-patterns, budget). [prompt.ts:promptCase] [prompt.ts:PromptCaseBuilder]
- `executionCase(id)` and `ExecutionCaseBuilder` build an `ExecutionEvalCase` (fixture, target, task, conditions, workflow, assertions, verifiers, artifacts, anti-patterns, budget, workspace). [execution.ts:executionCase] [execution.ts:ExecutionCaseBuilder]
- `ExecutionWorkflowBuilder` adds agent-tty workflow steps: `createSession`, `input`, `run`, `waitFor`, `snapshot`, `screenshot`, `destroy`. [execution.ts:ExecutionWorkflowBuilder]
- `ExecutionAssertionBuilder` adds verifier specs: `verifier`, `snapshot`, `screenshot`, `eventLog`, `json`, `command`, `custom`, `snapshotContains`, `raw`. [execution.ts:ExecutionAssertionBuilder]
- `execution.ts` also exports `ALL_EXECUTION_CONDITIONS`, the `*_PATTERN` constants and `anyOf`, imported from `evals/execution/cases/shared.ts`. [execution.ts:export {...}]
- `dogfoodCase(id)` and `DogfoodCaseBuilder` build a `DogfoodEvalCase` (bundle path, bundle requirements, proof bundle, report, validation profile, verifiers, workflow, budget, workspace). [dogfood.ts:dogfoodCase] [dogfood.ts:DogfoodCaseBuilder]
- `DogfoodProofBundleBuilder` adds artifact requirements: `requiresScreenshot` (`.png`), `requiresRecording` (`.cast`), `requiresNotes` (markdown notes), `raw`. [dogfood.ts:DogfoodProofBundleBuilder]
- `ReportBuilder` builds `ReportRequirement[]`: `section` plus the presets `title`, `reproductionSteps`, `findingsWithSeverity`, `evidenceReferences`. [report.ts:ReportBuilder]
- `WorkflowBuilder` and `WorkflowStepBuilder` build `WorkflowCheck[]` with `step`, `mustMention`, `mustNotMention`, `dependsOn`/`after`, `required`/`optional`, `weight`. [workflow.ts:WorkflowBuilder] [workflow.ts:WorkflowStepBuilder]
- `rawWorkflowCheck`, `rawVerifier`, `rawArtifactRequirement`, `rawReportRequirement` are typed identity functions for hand-written objects. [raw.ts:rawWorkflowCheck]
- Internal helpers (not re-exported): `compileAndValidate`, `cloneValue`, `assertUniqueId`, `assertDefined`, `assertNonEmptyArray`, `assertCase`, `failCase`, `createCaseError`, `toPatternSource`, `formatAuthoringPath`, and the types `AuthoringPath` and `PatternInput` (the pattern input of most builder setters). [compile.ts:compileAndValidate] [compile.ts:PatternInput]

## Invariants

- Every builder error has the form `Invalid <lane> case "<id>" at <path>: <message>`. [compile.ts:createCaseError]
- `build()` validates with `compileAndValidate`, which runs `schema.safeParse` and throws a case error at the first Zod issue path. The schemas `PromptEvalCaseSchema`, `ExecutionEvalCaseSchema` and `DogfoodEvalCaseSchema` come from `evals/lib/schemas.ts`. [compile.ts:compileAndValidate]
- Builder state must survive `structuredClone`. Otherwise `cloneValue` throws a case error. [compile.ts:cloneValue]
- Workflow step ids, verifier ids and report requirement ids must be unique per builder. [compile.ts:assertUniqueId]
- A workflow step cannot require and forbid the same literal pattern. [workflow.ts:WorkflowBuilder.assertNoContradiction]
- `PromptCaseBuilder.build()` requires category, prompt and expected skill, and at least one expected pattern. The default budget is `timeoutMs: 30_000`. [prompt.ts:PromptCaseBuilder] [prompt.ts:DEFAULT_PROMPT_TIMEOUT_MS]
- `ExecutionCaseBuilder.build()` requires category, task, a fixture or a target, at least one condition, and at least one verifier. It sets lane `execution` and expected skill `agent-tty`. [execution.ts:ExecutionCaseBuilder]
- `DogfoodCaseBuilder.build()` requires category, task, bundle path, validation profile, at least one bundle requirement and at least one condition. It sets lane `dogfood` and expected skill `dogfood-tui`. Default budgets are `timeoutMs: 600_000`, `maxAgentSteps: 30`, `maxWallClockMs: 600_000`. [dogfood.ts:DogfoodCaseBuilder] [dogfood.ts:DEFAULT_DOGFOOD_BUDGETS]
- If `workflow()` was called, `build()` requires at least one workflow check (all three case builders). [prompt.ts:PromptCaseBuilder]

## Side Effects

- None found in code. The builders do no file, process, network or environment access. They throw `Error` on invalid input. [compile.ts:failCase]

## Verification

- Run: `npx vitest run test/unit/evals/authoring test/unit/evals/snapshots/fingerprint.test.ts`
- Run: `npm run typecheck`
