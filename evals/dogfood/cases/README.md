# evals/dogfood/cases

## Overview

This directory defines the six dogfood-lane eval cases and one prompt helper. Each case asks an agent to explore a fixture app with agent-tty and to write a proof bundle and a report. One case uses the authoring façade. The other five are literal objects that pass through `DogfoodEvalCaseSchema.parse` from `evals/lib/schemas.ts`. `evals/dogfood/runner.ts` imports all six.

## Interface

- `dogfoodTaskPrompt(task, fixture?)` returns the task prompt: fixed instructions (use `npx tsx src/cli/main.ts`, use the isolated `AGENT_TTY_HOME`, capture the proof bundle), an optional fixture line for `test/fixtures/apps/<fixture>/main.ts`, and the trimmed task. [shared.ts:dogfoodTaskPrompt]
- `exploratoryQaCase` (default export too): id `exploratory-qa`, category `qa`, fixture `hello-prompt`, profile `interactive-renderer`, workspace `agent-tty-smoke`. It is built with `dogfoodCase(...).build()` from `evals/authoring/index.ts`. [exploratory-qa.ts:exploratoryQaCase]
- `releaseReadinessCase` (default export too): id `release-readiness`, category `release-readiness`, fixture `color-grid`, profile `interactive-renderer`. [release-readiness.ts:releaseReadinessCase]
- `renderingBugReproCase` (default export too): id `rendering-bug-repro`, category `bug-repro`, fixture `unicode-grid`, profile `interactive-renderer`. [rendering-bug-repro.ts:renderingBugReproCase]
- `navigationFocusReproCase` (default export too): id `navigation-focus-repro`, category `bug-repro`, fixture `hello-prompt`, profile `contract-reporting`. [navigation-focus-repro.ts:navigationFocusReproCase]
- `resizeRegressionCase` (default export too): id `resize-regression`, category `bug-repro`, fixture `resize-demo`, profile `interactive-renderer`. [resize-regression.ts:resizeRegressionCase]
- `evidenceCompletenessCase` (default export too): id `evidence-completeness`, category `reporting`, fixture `scrollback-demo`, profile `interactive-renderer`. [evidence-completeness.ts:evidenceCompletenessCase]
- Each literal-object file has local, non-exported `requiredArtifact` and `reportRequirement` helpers. `navigation-focus-repro.ts` and `release-readiness.ts` also have `optionalArtifact`. [release-readiness.ts:optionalArtifact]

## Invariants

- `dogfoodTaskPrompt` throws `dogfood task prompt must not be empty` when the trimmed task is empty. [shared.ts:dogfoodTaskPrompt]
- The five literal cases must pass `DogfoodEvalCaseSchema.parse`. An invalid case throws when the module loads. [resize-regression.ts:resizeRegressionCase]
- `exploratoryQaCase` must pass `DogfoodCaseBuilder.build()` validation in `evals/authoring/dogfood.ts`. [exploratory-qa.ts:exploratoryQaCase]
- Local helper return values are typed as `ArtifactRequirement` and `ReportRequirement` from `evals/lib/types.ts`. [evidence-completeness.ts:requiredArtifact] [evidence-completeness.ts:reportRequirement]

## Side Effects

- None found in code. The modules do no file, process, network or environment access. Schema validation and the façade `build()` run at import time. [evidence-completeness.ts:evidenceCompletenessCase] [exploratory-qa.ts:exploratoryQaCase]

## Verification

- Run: `npx vitest run test/unit/evals/authoring/parity.test.ts test/unit/evals/dogfoodRunner.test.ts`
- Integration: `npx vitest run --maxWorkers=1 test/integration/evals/authoring-pilots.test.ts`
- Run: `npm run typecheck`
