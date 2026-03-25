# 2026-03-25 dogfood — Week 7 bundle B envelope locks proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week7-b-envelope-locks/`
- **Test file:** `test/unit/commands/golden-envelopes.test.ts`
- **CLI entrypoint:** `src/cli/main.ts`
- **Captured logs:** `logs/01-vitest-verbose.txt`, `logs/02-vitest-json.json`, and `logs/03-test-source.txt`
- **Screenshots directory:** `screenshots/` now includes `01-review-page-verified.png` from the Week 7 remediation browser-verification pass.

## Scenario summary

This refreshed bundle reran `test/unit/commands/golden-envelopes.test.ts` and preserved both Vitest reporters plus the current test source. The current suite reports **28 passing tests** across **10 command surfaces** locked by success-envelope and strict-schema assertions, plus two representative `inspect` error envelopes. The expanded suite now covers `create`, `list`, `send-keys`, `snapshot`, `screenshot`, `destroy`, `wait` (legacy), `wait` (render), `inspect`, and `version`.

## Coverage assessment

| Surface         | Golden-envelope status | Notes                                                                                                                              |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `create`        | Locked                 | Valid/invalid/extra-field tests via the local strict `CreateResultSchema`.                                                         |
| `list`          | Locked                 | Valid/invalid/extra-field tests via the local strict `ListResultSchema`.                                                           |
| `send-keys`     | Locked                 | Valid/invalid/extra-field tests via protocol `SendKeysResultSchema`.                                                               |
| `snapshot`      | Locked                 | Valid/invalid/extra-field tests via protocol `SnapshotResultSchema`.                                                               |
| `screenshot`    | Locked                 | Valid/invalid/extra-field tests via protocol `ScreenshotResultSchema`.                                                             |
| `destroy`       | Locked                 | Valid/invalid/extra-field tests via protocol `DestroyResultSchema`.                                                                |
| `wait` (legacy) | Locked                 | Valid/invalid/extra-field tests via protocol `WaitResultSchema`.                                                                   |
| `wait` (render) | Locked                 | Valid/invalid/extra-field tests via protocol `WaitForRenderResultSchema`.                                                          |
| `inspect`       | Locked                 | One success-envelope golden plus two representative error-envelope goldens (`SESSION_NOT_FOUND` and retryable `HOST_UNREACHABLE`). |
| `version`       | Locked                 | Success envelope validated via the local strict `VersionResultSchema` around `buildVersionResult()`.                               |
| `type`          | Unlocked               | No golden test covers the `type` success or error envelopes.                                                                       |
| `paste`         | Unlocked               | No golden test covers the `paste` success or error envelopes.                                                                      |
| `gc`            | Unlocked               | No golden test covers the `gc` success or error envelopes.                                                                         |
| `record export` | Unlocked               | No golden test covers the `record export` success or error envelopes.                                                              |
| `doctor`        | Unlocked               | No golden test covers the `doctor` success or error envelopes.                                                                     |

## Locked-suite breakdown

- **24 tests** come from the eight strict result-contract surfaces with valid, invalid, and extra-field cases: `create`, `list`, `send-keys`, `snapshot`, `screenshot`, `destroy`, `wait` (legacy), and `wait` (render).
- **1 test** locks the `inspect` success envelope shape.
- **1 test** locks the `version` success envelope shape.
- **2 tests** lock representative `inspect` error envelopes.

## Review answers

- **Did all tests pass?** Yes. `logs/01-vitest-verbose.txt` reports 1 passed test file and 28 passed tests, and `logs/02-vitest-json.json` reports `success: true`.
- **What is the exact test count (passed/failed/skipped)?** 28 passed, 0 failed, 0 skipped/pending/todo, out of 28 total tests.
- **What surfaces remain unlocked?** `type`, `paste`, `gc`, `record export`, and `doctor` remain outside the current golden-envelope suite.

## Issues / limitations

- The suite now locks the representative Week 7 contract surfaces, but it still leaves the lower-priority `type`, `paste`, `gc`, `record export`, and `doctor` surfaces unlocked.
- The `inspect` surface is locked at the success envelope plus two representative error envelopes preserved here; other `inspect` branches are not separately golden-locked.
- In this child worktree, `npx` routed through an untrusted `mise.toml`, so the refreshed capture used the equivalent local binaries after `npm ci --ignore-scripts`; the checked-in logs in this bundle are the current source of truth.

## Browser Verification (Week 7 remediation)

Review page verified via `agent-browser` — see `screenshots/01-review-page-verified.png`.
