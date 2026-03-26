# 2026-03-25 dogfood — Week 8 contract-locks proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week8-contract-locks/`
- **Test file:** `test/unit/commands/golden-envelopes.test.ts`
- **CLI entrypoint:** `src/cli/main.ts`
- **Captured logs:** `logs/01-golden-envelopes.json`, `logs/02-golden-envelopes.txt`
- **Bundle-local JSON mirror:** `snapshots/01-golden-envelopes.json`
- **Review screenshot:** `screenshots/01-review-page.png`
- **Validation target:** `npm run validate-bundle -- dogfood/20260325-week8-contract-locks --profile contract-reporting`

## Scenario summary

This bundle reran the Week 8 golden-envelope contract suite and preserved both the machine-readable and human-readable Vitest outputs. The current suite reports **45 passing tests** in **1 passing test file**, with the JSON reporter also reporting **15 passing suite sections** and `success: true`.

The suite locks the Week 8 CLI contract surface for these commands:

- `doctor` success envelopes via `DoctorResultSchema`
- `gc` success envelopes via `GcResultSchema`, including the dry-run variant
- `record export` success envelopes via `RecordExportResultSchema` for both `asciicast` and `webm`
- `version` success envelopes, including the Week 8 optional `capabilities` list on top of the existing runtime and renderer backend facts
- `inspect` success envelopes, including the Week 8 `rendererRuntime` structure and `usedOfflineReplay`/artifact-health fields

## Week 8 fields locked by the suite

| Surface         | Locked Week 8 fields                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`        | `ok`; `checks.environment[]` and `checks.renderer[]` entries with `name`, `status`, `message`, and `durationMs`; `capabilities[]` entries validated through `CapabilityEntrySchema`                                                                                                                |
| `gc`            | `removedSessions[]`; `skippedSessions[]` entries with `sessionId` and `reason`; `dryRun`; `totalBytesFreed`                                                                                                                                                                                        |
| `record export` | `sessionId`; `format`; `artifactPath`; `bytes`; `sha256`; `capturedAtSeq`; `metadata`; optional `durationMs` for the asciicast contract                                                                                                                                                            |
| `version`       | `cliVersion`; `protocolVersion`; `rendererBackends[]`; `runtime.node`; `runtime.platform`; `runtime.arch`; optional `capabilities[]`                                                                                                                                                               |
| `inspect`       | `session`; `eventCount`; `uptime`; `lastEventSeq`; `terminationCategory`; `artifacts.total`; `artifacts.byKind`; `artifacts.missingCount`; `artifacts.health`; `usedOfflineReplay`; `rendererRuntime.backend`; `rendererRuntime.mode`; `rendererRuntime.status`; optional `rendererRuntime.reason` |

## Observed results

- `logs/01-golden-envelopes.json` reports `numTotalTests: 45`, `numPassedTests: 45`, `numFailedTests: 0`, and `success: true`.
- `snapshots/01-golden-envelopes.json` preserves the same pretty-printed JSON summary in a non-`logs/` path so the review and validation tooling can parse it as a JSON artifact.
- `logs/02-golden-envelopes.txt` reports `1 passed` test file and `45 passed` tests.
- `logs/01-golden-envelopes.stderr.txt` and `logs/02-golden-envelopes.stderr.txt` are empty for the successful capture.
- `screenshots/01-review-page.png` captures the generated local review page after `index.html` regeneration.

## Review answers

- **Did all golden envelopes pass?** Yes. Both captured Vitest reporters show the suite passing cleanly, and the JSON reporter marks the run as `success: true`.
- **What specific Week 8 fields were locked?** The suite now locks the `doctor`, `gc`, and `record export` result envelopes, plus the Week 8 `version.capabilities[]` shape and the `inspect.rendererRuntime`/`usedOfflineReplay` contract additions listed above.

## Issues / limitations

- The proof bundle captures the contract tests themselves; it does not execute the live CLI commands behind those contracts.
- The screenshot in `screenshots/` is a review-page artifact generated from the local HTML review output, not a CLI screenshot surface.
