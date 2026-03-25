# 2026-03-25 dogfood — Week 7 bundle B envelope locks proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week7-b-envelope-locks/`
- **Test file:** `test/unit/commands/golden-envelopes.test.ts`
- **CLI entrypoint:** `src/cli/main.ts`
- **Captured logs:** `logs/01-vitest-verbose.txt`, `logs/02-vitest-json.json`, and `logs/03-test-source.txt`
- **Screenshots directory:** `screenshots/` now includes `01-review-page-verified.png` from the Week 7 remediation browser-verification pass.

## Scenario summary

This bundle proves the current golden-envelope coverage by running `test/unit/commands/golden-envelopes.test.ts` with verbose and JSON Vitest reporters, then preserving the test source that defines the assertions. The suite currently locks one success envelope for `inspect`, one success envelope for `version`, and two representative `inspect` error envelopes: a non-retryable `SESSION_NOT_FOUND` case and a retryable transport-style `HOST_UNREACHABLE` case.

## Locked surfaces inventory

### 1. `locks the inspect success envelope shape`

- **Schema / envelope locked:** `InspectResultSchema` from `src/protocol/messages.ts` plus `createSuccessEnvelope('inspect', result)` from `src/protocol/envelope.ts`.
- **Fields asserted:** envelope `ok`, `command`, `timestamp`, and `result`; result `session.version`, `session.sessionId`, `session.createdAt`, `session.updatedAt`, `session.status`, `session.command`, `session.cwd`, `session.cols`, `session.rows`, `session.hostPid`, `session.childPid`, `session.exitCode`, `session.exitSignal`, `eventCount`, `uptime`, `lastEventSeq`, `terminationCategory`, `artifacts.total`, `artifacts.byKind.screenshot`, `artifacts.byKind.snapshot`, `artifacts.missingCount`, `artifacts.health`, and `usedOfflineReplay`.
- **Coverage shape:** subset of the ratified `inspect` surface. It exercises a healthy artifact summary and a clean-exit session, but it does not cover alternate `terminationCategory` values, the optional `artifacts.missing` list, or cases where optional inspect fields are absent.

### 2. `locks the version success envelope shape`

- **Schema / envelope locked:** the local strict `VersionResultSchema` declared in the test file plus `createSuccessEnvelope('version', result)`, where `result` is produced by `buildVersionResult()` from `src/cli/commands/version.ts`.
- **Fields asserted:** envelope `ok`, `command`, `timestamp`, and `result`; result `cliVersion`, `protocolVersion`, `rendererBackends`, and `runtime.node`, `runtime.platform`, `runtime.arch`.
- **Coverage shape:** effectively the full current `version` JSON success surface, because the test validates the emitted result against a strict schema and locks the success-envelope wrapper around that emitted object. The exact runtime values stay dynamic rather than being hard-coded literals.

### 3. `locks the SESSION_NOT_FOUND error envelope shape`

- **Schema / envelope locked:** `createErrorEnvelope('inspect', error)` with a `SESSION_NOT_FOUND` CLI error.
- **Fields asserted:** envelope `ok`, `command`, and `timestamp`; error `code`, `message`, `retryable`, `details.sessionId`, and `details.manifestPath`.
- **Coverage shape:** subset of the shared error surface. It locks one concrete non-retryable error example for `inspect`, not the entire set of command-specific error payloads.

### 4. `locks a retryable transport-style error envelope shape`

- **Schema / envelope locked:** `createErrorEnvelope('inspect', error)` with a `HOST_UNREACHABLE` CLI error.
- **Fields asserted:** envelope `ok`, `command`, and `timestamp`; error `code`, `message`, `retryable`, and `details.sessionId`.
- **Coverage shape:** subset of the shared error surface. It proves one retryable transport-style example, but it does not lock every retryable code or every command context.

## Coverage assessment

The requested ratified surface list is `create`, `send-keys`, `type`, `paste`, `snapshot`, `screenshot`, `list`, `inspect`, `destroy`, `version`, and `doctor`. Against that list, the current golden suite coverage is:

| Surface      | Golden-envelope status | Notes                                                                                                                            |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `create`     | Unlocked               | No golden success or error test targets the create envelope.                                                                     |
| `send-keys`  | Unlocked               | No golden test covers the send-keys result schema or wrapper.                                                                    |
| `type`       | Unlocked               | No golden test covers the type envelope.                                                                                         |
| `paste`      | Unlocked               | No golden test covers the paste envelope.                                                                                        |
| `snapshot`   | Unlocked               | No golden test covers snapshot success or error envelopes.                                                                       |
| `screenshot` | Unlocked               | No golden test covers screenshot success or error envelopes.                                                                     |
| `list`       | Unlocked               | No golden test covers list envelopes.                                                                                            |
| `inspect`    | Partially locked       | One success-envelope golden plus two representative error-envelope goldens exist, but they do not exhaust every inspect variant. |
| `destroy`    | Unlocked               | No golden test covers destroy envelopes.                                                                                         |
| `version`    | Locked                 | The current version success envelope is covered by the golden suite.                                                             |
| `doctor`     | Unlocked               | No golden test covers doctor envelopes.                                                                                          |

So the suite currently locks 2 of the 11 listed public success surfaces at all (`inspect` partially and `version` fully), while 9 remain entirely unlocked by golden-envelope tests.

## Review answers

- **Did all tests pass?** Yes. `logs/01-vitest-verbose.txt` reports 1 passed test file and 4 passed tests, and `logs/02-vitest-json.json` reports `success: true`.
- **What is the exact test count (passed/failed/skipped)?** 4 passed, 0 failed, 0 skipped/pending/todo, out of 4 total tests.
- **What surfaces remain unlocked?** `create`, `send-keys`, `type`, `paste`, `snapshot`, `screenshot`, `list`, `destroy`, and `doctor` remain fully unlocked. `inspect` also has unlocked branches beyond the one success case and two representative errors preserved here.

## Issues / limitations

- The golden suite currently locks only `inspect`, `version`, and shared error-envelope examples. It does **not** lock the entire ratified public JSON surface list.
- The bundle is intentionally descriptive rather than expansive: it documents the current suite exactly as-is and does not add or broaden any golden coverage.
- The original proof did not require screenshots, but Week 7 remediation added `screenshots/01-review-page-verified.png` so the bundle now includes reviewer-visible browser evidence.

## Browser Verification (Week 7 remediation)

Review page verified via `agent-browser` — see `screenshots/01-review-page-verified.png`.
