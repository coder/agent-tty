# ADR 0001: Adopt Oxc lint and format tooling

Date: 2026-04-29

## Status

Accepted

## Context

The repository previously used ESLint with `typescript-eslint` strict type-checked rules for linting and Prettier for repository-wide formatting. The migration goal was performance without a correctness regression, not rule churn for its own sake.

Baseline timings were taken in this Mux cloud dev container before changing dependencies. The absolute numbers are environment-specific; the replacement ratios were the decision input:

| Check        | Previous command                                                     | Wall time |
| ------------ | -------------------------------------------------------------------- | --------: |
| Format check | `npm run format:check` / `prettier . --check`                        |      6.9s |
| Lint         | `npm run lint` / `eslint src test vitest.config.ts --max-warnings=0` |      9.0s |

The current Oxc timing samples after configuring and removing the replaced tools were:

| Check        | New command                                         | Wall time samples |
| ------------ | --------------------------------------------------- | ----------------: |
| Format check | `npm run format:check` / `oxfmt . --check`          |  1.5s, 1.4s, 1.5s |
| Lint         | `npm run lint` / `oxlint src test vitest.config.ts` |  1.0s, 1.1s, 1.0s |

Both replacements exceed the 2x performance threshold in this workspace.

## Decision

Replace Prettier with Oxfmt and replace ESLint with Oxlint.

Committed integration points now use:

- `.oxfmtrc.json` for formatter behavior, migrated from the previous Prettier settings.
- `.oxlintrc.json` for lint behavior, including type-aware linting via `oxlint-tsgolint`.
- `npm run format`, `npm run format:check`, `npm run lint`, and `npm run lint:fix` as the stable task entry points.
- Existing `mise` and CI tasks continue to call the npm scripts.

No TypeScript upgrade was required.

## Safety parity notes

The Oxlint config keeps the repo's important safety checks enabled, including:

- type-only import enforcement,
- floating promise detection,
- confusing void expression detection with `ignoreArrowShorthand: true`,
- strict type-aware unsafe-value checks such as `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-member-access`, and `no-unsafe-return`,
- promise misuse and unnecessary-condition checks.

A temporary fixture under `test/` was checked with both tools before removal. The reproduced output is preserved in `dogfood/oxlint-oxfmt-migration/logs/safety-parity.txt`. ESLint and Oxlint both rejected the fixture for the migration-critical cases:

- `consistent-type-imports`,
- `no-floating-promises`,
- `no-unsafe-assignment`,
- `no-confusing-void-expression`,
- `require-await`.

A few rule/configuration details are intentionally documented rather than left implicit:

- `typescript/no-floating-promises` is listed explicitly in `.oxlintrc.json` even though the `correctness` category also enables it, because it is a migration-critical guarantee.
- `typescript/ban-ts-comment` keeps `minimumDescriptionLength: 10` from the captured ESLint `--print-config` output.
- `no-octal` is not an Oxlint rule, but TypeScript rejects legacy octal literals during parsing/typechecking.
- `no-useless-assignment` produced Oxlint false positives in existing integration-test cleanup patterns and is non-safety-oriented, so it is disabled in `.oxlintrc.json`.
- `unicorn/no-new-array` is disabled because `test/unit/host/eventLog.test.ts` intentionally uses `new Array(MAX_EVENT_BUFFER_ENTRIES)` to pre-allocate the event buffer in a bounded-buffer test.

## Formatter churn

Oxfmt was migrated from the Prettier config and preserves the previous practical formatting intent:

- single quotes,
- trailing commas,
- semicolons,
- print width 80,
- package JSON sorting disabled,
- ignore behavior for `coverage`, `design`, `dist`, `node_modules`, and `package-lock.json`.

Running Oxfmt did not require a source formatting churn diff beyond the tooling/configuration changes.

## Consequences

- Lint and format checks are materially faster for local and CI workflows.
- Native Oxc packages are now part of the install surface. The lockfile includes Linux and macOS packages used by the repository's CI platforms.
- `oxfmt` is still pre-1.0; future formatter upgrades should be treated as intentional formatting-change reviews because a minor-version bump may change formatting behavior.
- ESLint and Prettier remain absent from required checks; keeping a permanent hybrid lint setup was rejected because it would preserve the old slow path and undermine the migration goal.
- Historical dogfood artifacts that mention ESLint or Prettier remain archival records and are not rewritten.
