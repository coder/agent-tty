# evals/snapshots

## Overview

Token-usage snapshots for eval cases. Each snapshot entry records the token counts of one (provider, model, lane, case, condition, case fingerprint) combination. `store.ts` loads and writes per-provider-and-model JSONL snapshot files. `fingerprint.ts` hashes the semantic fields of a case, so an edited case does not match an old snapshot entry. `compare.ts` compares current token totals with stored totals and builds a `SnapshotCheckReport` with a regression threshold. The report schemas live in the child directory `schemas/`.

## Interface

- [./schemas/README.md](./schemas/README.md): Zod schemas and types for the snapshot check report (`SnapshotCheckReportSchema`, `SnapshotCheckCaseSchema`, `SnapshotCheckSummarySchema`, `SnapshotCheckOutcomeSchema`).
- `[schema.ts:SnapshotEntrySchema]`: strict Zod object with `provider`, `model`, `lane`, `caseId`, `condition`, `caseFingerprint`, `inputTokens`, `outputTokens`, `totalTokens`, optional `cachedTokens`, and `createdAtMs`. `[schema.ts:SnapshotEntry]` is its type. Field schemas are reused from `evals/lib/schemas.ts`.
- `[schema.ts:buildSnapshotLogicalKey]`: returns `JSON.stringify([lane, caseId, condition, caseFingerprint])`. The key leaves out provider and model. `[schema.ts:SnapshotLogicalKeyFields]` is its input type.
- `[fingerprint.ts:caseFingerprint]`: returns the lowercase SHA-256 hex of key-sorted JSON built from a case's semantic fields.
- `[compare.ts:compareSnapshotRecords]`: matches current and stored records on provider, model, lane, case, condition and fingerprint. Returns a `SnapshotCheckReport` with cases sorted by key and summary counts. Types: `[compare.ts:SnapshotComparableRecord]`, `[compare.ts:CompareSnapshotRecordsOptions]`. It re-exports the report types from `./schemas/report.ts`.
- `[store.ts:snapshotFilePath]`: returns `<snapshotDir>/<provider>-<model>.jsonl` as an absolute path.
- `[store.ts:loadSnapshotFile]`: reads a snapshot file and returns `{ entries, diagnostics }`. It skips malformed lines and, when `validCurrentKeys` is given, stale lines. Types: `[store.ts:LoadSnapshotFileOptions]`, `[store.ts:SnapshotLoadDiagnostic]`.
- `[store.ts:writeSnapshotFile]`: merges incoming entries into the existing file and rewrites it. An incoming entry replaces the existing entry with the same logical key in place. New keys go at the end in input order. The rewrite drops existing malformed lines and later duplicates of an existing logical key. Type: `[store.ts:WriteSnapshotFileOptions]`.

## Invariants

- `[schema.ts:SnapshotEntrySchema]` is `.strict()`. `[schema.ts:Sha256HexSchema]` requires `caseFingerprint` to be lowercase SHA-256 hex.
- `[fingerprint.ts:projectCaseSemanticFields]` throws when the case fails `EvalCaseSchema`. The hash covers `id`, `lane`, `category`, `prompt`, each workflow check's `id`, `requiredPatterns`, `forbiddenPatterns` and `dependsOn`, and each anti-pattern rule's `id`, `patterns`, `severity` and `lanes`. Edits to a check's `description`, `required` or `weight`, or to a rule's `description` or `suggestedFix`, do not change the hash. Prompt-lane cases also add `expectedPatterns` and `forbiddenPatterns`. Other case fields do not change the hash.
- `[fingerprint.ts:normalizeForStableJson]` sorts object keys recursively and keeps array order, so object key order does not change the hash.
- `[compare.ts:compareSnapshotRecords]` throws unless `regressionThresholdPercent` is finite and at least 0. `[compare.ts:createRecordMap]` throws on a record that fails its schema or on a duplicate comparison key in one set.
- `[compare.ts:classifySnapshotCase]` outcomes: only current gives `new`, only stored gives `orphaned`, current below stored gives `improved`, and current above `stored * (1 + threshold / 100)` gives `regressed`. Everything else is `unchanged`. `deltaPercent` is left out when the stored total is 0.
- `[store.ts:resolveSnapshotDir]` requires a non-empty snapshot directory that resolves to an absolute path. `[store.ts:snapshotFilePath]` checks `provider` and `model` with `validatePathSegment` from `evals/lib/artifacts.ts`, and `[store.ts:assertPathInsideBase]` keeps the file inside the directory.
- `[store.ts:writeSnapshotFile]` validates entries with `SnapshotEntrySchema` and throws on duplicate logical keys in the request. `[store.ts:assertEntryMatchesFile]` requires each entry's provider and model to match the file.
- `[store.ts:loadSnapshotFile]` returns no entries for a missing file when `allowMissing` is true (the default) and rethrows other read errors.

## Side Effects

- `[store.ts:loadSnapshotFile]` reads the snapshot file with `readFile` from `node:fs/promises`. `[store.ts:warnSkippedSnapshotEntry]` calls `console.warn` for each malformed or stale line.
- `[store.ts:writeSnapshotFile]` reads the existing file through `loadSnapshotFile`, then writes the merged JSONL through `writeTextFileAtomic` from `src/storage/manifests.ts`. Each write deletes existing malformed lines and duplicate logical-key lines from disk.
- `[fingerprint.ts:caseFingerprint]` hashes in memory with `node:crypto` `createHash('sha256')`. No I/O.
- `compare.ts` and `schema.ts`: none found in code.

## Verification

- Run: `npx vitest run test/unit/evals/snapshots`
- Run: `npx vitest run --maxWorkers=1 test/integration/evals-snapshots.test.ts`
- Run: `npm run typecheck`
