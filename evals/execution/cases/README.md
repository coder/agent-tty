# evals/execution/cases

## Overview

This directory defines the ten execution-lane eval cases and the helpers they share. Each case asks an agent to drive a fixture app with the agent-tty CLI and lists the workflow checks, verifiers and artifacts that prove the run. Eight cases are literal objects passed to `createExecutionCase`. Two (`doctor-gated`, `hello-prompt`) use the `executionCase` façade from `evals/authoring/index.ts`. `evals/execution/runner.ts` imports all ten.

## Interface

- `ALL_EXECUTION_CONDITIONS` is a copy of `SKILL_CONDITIONS` from `evals/lib/matrix.ts`. [shared.ts:ALL_EXECUTION_CONDITIONS]
- `ExecutionRendererRequirement` (`'none' | 'optional' | 'required'`), `ExecutionReadinessTier` and `ExecutionCaseCoverageMetadata` describe case readiness. [shared.ts:ExecutionRendererRequirement] [shared.ts:ExecutionReadinessTier] [shared.ts:ExecutionCaseCoverageMetadata]
- `EXECUTION_CASE_COVERAGE` maps each case id to its readiness tier, renderer requirement and summary. `getExecutionCaseCoverage(caseId)` returns one entry. [shared.ts:EXECUTION_CASE_COVERAGE] [shared.ts:getExecutionCaseCoverage]
- `anyOf(...patterns)` builds a regex alternation. `ordered(...patterns)` joins patterns in order with a lazy gap. [shared.ts:anyOf] [shared.ts:ordered]
- Transcript patterns: `CREATE_SESSION_PATTERN`, `DESTROY_SESSION_PATTERN`, `WAIT_PATTERN`, `SNAPSHOT_PATTERN`, `SCREENSHOT_PATTERN`, `RESIZE_PATTERN`, `INSPECT_PATTERN`, `RUN_PATTERN`, `TYPE_PATTERN`, `RECORD_EXPORT_PATTERN`, `DOCTOR_JSON_PATTERN`. [shared.ts:CREATE_SESSION_PATTERN]
- `executionAntiPatterns(...extraRules)` returns copies of `DEFAULT_ANTI_PATTERN_RULES` plus the extra rules. [shared.ts:executionAntiPatterns]
- `executionTaskPrompt(task, fixture?)` builds the task prompt with fixed agent-tty and `AGENT_TTY_HOME` instructions. [shared.ts:executionTaskPrompt]
- `fixtureSetupStep(id, fixture, description, timeoutMs = 30_000)` returns a `SetupStep` from `fixtureCommand` in `evals/lib/cliHarness.ts`. [shared.ts:fixtureSetupStep]
- `requiredVerifier`, `customVerifier`, `workflowCheck`, `artifactRequirement` build verifier specs, workflow checks and artifact requirements. [shared.ts:requiredVerifier] [shared.ts:customVerifier] [shared.ts:workflowCheck] [shared.ts:artifactRequirement]
- `executionBudgets(overrides)` merges overrides into `timeoutMs: 120_000`, `maxAgentSteps: 16`, `maxWallClockMs: 90_000`. [shared.ts:executionBudgets]
- `createExecutionCase(definition)` validates a case with `ExecutionEvalCaseSchema.parse` and returns it. [shared.ts:createExecutionCase]
- Session cases: `helloPromptCase` (façade, workspace `agent-tty-smoke`), `runCommandCase`. [hello-prompt.ts:helloPromptCase] [run-command.ts:runCommandCase]
- TUI cases: `altScreenDemoCase`, `resizeDemoCase`, `scrollbackDemoCase`. [alt-screen-demo.ts:altScreenDemoCase] [resize-demo.ts:resizeDemoCase] [scrollback-demo.ts:scrollbackDemoCase]
- Artifact cases: `colorGridCase`, `unicodeGridCase`, `exportProofCase` (requires `.cast` and `.webm`), `doctorGatedCase` (façade, `doctor --json` before a screenshot). [color-grid.ts:colorGridCase] [unicode-grid.ts:unicodeGridCase] [export-proof.ts:exportProofCase] [doctor-gated.ts:doctorGatedCase]
- Recovery case: `crashRecoveryCase` (fixture `crash-demo`). [crash-recovery.ts:crashRecoveryCase]

## Invariants

- `getExecutionCaseCoverage` throws for an unknown case id. [shared.ts:getExecutionCaseCoverage]
- Every coverage entry must satisfy `ExecutionCaseCoverageMetadata` (`as const satisfies`). [shared.ts:EXECUTION_CASE_COVERAGE_BY_ID]
- `anyOf` and `ordered` require at least one pattern. [shared.ts:anyOf] [shared.ts:ordered]
- `executionTaskPrompt` rejects an empty trimmed task. [shared.ts:executionTaskPrompt]
- `fixtureSetupStep` requires `fixtureCommand(fixture)` to return a command. [shared.ts:fixtureSetupStep]
- Literal cases must pass `ExecutionEvalCaseSchema` from `evals/lib/schemas.ts`. Façade cases must pass `ExecutionCaseBuilder.build()`. [shared.ts:createExecutionCase] [hello-prompt.ts:helloPromptCase]
- `requiredVerifier`, `customVerifier` and `artifactRequirement` set `required: true`. `workflowCheck` defaults `required` to `false`. [shared.ts:requiredVerifier] [shared.ts:artifactRequirement] [shared.ts:workflowCheck]

## Side Effects

- Case validation runs at import time, so an invalid case throws when its module loads. [shared.ts:createExecutionCase]
- `fixtureSetupStep` calls `fixtureCommand`, which reads `process.execPath`. It starts no process and does no file access. [shared.ts:fixtureSetupStep]
- Otherwise none found in code.

## Verification

- Run: `npx vitest run test/unit/evals/authoring/parity.test.ts test/unit/evals/executionRunner.test.ts`
- Integration: `npx vitest run --maxWorkers=1 test/integration/evals/authoring-pilots.test.ts`
- Run: `npm run typecheck`
