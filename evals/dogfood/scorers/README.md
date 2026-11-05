# evals/dogfood/scorers

## Overview

This directory scores one dogfood-lane trial. `scoreDogfoodRun` combines bundle scores from `evals/lib/bundleScoring.ts` with three local text scorers into a `DogfoodScore`. `evals/dogfood/runner.ts` calls it after the agent run.

## Interface

- `DogfoodScore` has six numbers: `bundleCompleteness`, `reportCompleteness`, `evidenceQuality`, `taxonomyUsage`, `reproducibility`, `overallScore`. [index.ts:DogfoodScore]
- `scoreDogfoodRun(bundleDir, reportText, transcript, evalCase)` returns `Promise<DogfoodScore>`. `evalCase` is a `DogfoodEvalCase` from `evals/lib/types.ts`. [index.ts:scoreDogfoodRun]
- `scoreTaxonomyUsage(reportText)` returns 1 if any `TAXONOMY_PATTERNS` regex matches, else 0. [index.ts:scoreTaxonomyUsage]
- `scoreReproducibility(reportText)` returns the mean of four binary checks: a repro or steps heading, a list of steps, a command reference, and an outcome statement. [index.ts:scoreReproducibility]
- `scoreReportRequirements(reportText, requirements)` returns `{ score, details }` for `ReportRequirement[]` from `evals/lib/types.ts`. [index.ts:scoreReportRequirements]

## Invariants

- Each of the five score components has weight 0.2 in the frozen `DOGFOOD_SCORE_WEIGHTS`. [index.ts:DOGFOOD_SCORE_WEIGHTS]
- `clampUnitInterval` maps non-finite values to 0 and clamps the rest to [0, 1]. It is applied to `overallScore`, to averages and to the requirement score. [index.ts:clampUnitInterval]
- Text inputs must be strings (`invariant(typeof value === 'string')`). [index.ts:assertStringInput]
- Each report requirement id must be non-empty after trim. [index.ts:scoreReportRequirements]
- `scoreReportRequirements` returns score 1 for an empty requirement list. Required items weigh 1 and optional items weigh 0.5. [index.ts:scoreReportRequirements]
- In `scoreDogfoodRun`, bundle completeness and evidence quality are 0 when `bundleDir` is `undefined`. Taxonomy and reproducibility use the transcript when the report is blank. [index.ts:scoreDogfoodRun]

## Side Effects

- `scoreDogfoodRun` reads the bundle directory through `scoreBundleCompleteness` and `scoreEvidenceQuality` from `evals/lib/bundleScoring.ts` when `bundleDir` is set. [index.ts:scoreDogfoodRun]
- The other exports are pure string and regex code. [index.ts:scoreReportRequirements]

## Verification

- No automated test covers this directory directly. `test/unit/evals/dogfoodRunner.test.ts` loads it through `evals/dogfood/runner.ts` but tests only work-item enumeration.
- Run: `npx vitest run test/unit/evals/dogfoodRunner.test.ts`
- Run: `npm run typecheck`
