# Week 5 platform/documentation closure proof bundle

## Summary

Lane D completed the Week 5 platform/documentation closeout on 2026-03-23. This proof bundle captures reviewer-facing evidence that the repository now documents its platform tiers, runs tier-1 CI on both Ubuntu and macOS, records the Week 5 outcome in design docs, and honestly reclassifies the remaining gap tracker into shipped vs scaffolded vs future work.

## Platform tiers

- **Linux** — Tier-1, CI-tested on `ubuntu-latest`
- **macOS** — Tier-1, CI-tested on `macos-latest`
- **Windows** — Tier-2, not CI-tested

## CI changes

- Added a `quality-gates-macos` GitHub Actions job in `.github/workflows/ci.yml`.
- The macOS job mirrors the Ubuntu quality gates: checkout, mise setup, CI bootstrap, Playwright Chromium install, format check, lint, typecheck, test, and build.
- The workflow now reflects the intended Linux/macOS tier-1 support story directly in repo automation.

## Documentation changes

- `README.md` now includes a `## Platform Support` section that spells out Linux tier-1, macOS tier-1, and Windows tier-2.
- `design/20260319_agent-terminal-v1.md` updates the design entrypoint to the 2026-03-23 shipped status and calls out Week 5 foundational scaffolding plus macOS CI validation.
- `design/20260319_agent-terminal-v1/12-week-5-status.md` records the actual Week 5 outcome and marks Workstream D as completed.
- `design/20260319_agent-terminal-v1/11-week-5-plan.md` now includes a status update pointing readers to the Week 5 outcome.
- `WEEK2-GAPS.md` is reclassified as the post-Week-5 remaining-gap tracker with explicit shipped / scaffolded / future annotations.

## Validation results

All requested validation gates passed for the platform/documentation closeout:

- format ✅
- lint ✅
- typecheck ✅
- tests 5/5 ✅
- build ✅

## Exact commands run

```bash
npm run verify  (runs format:check, lint, typecheck, test, build)
npx prettier --check .github/workflows/ci.yml
npx prettier --check README.md
npx prettier --check WEEK2-GAPS.md
npx prettier --check design/20260319_agent-terminal-v1.md
npx prettier --check design/20260319_agent-terminal-v1/12-week-5-status.md
npx prettier --check design/20260319_agent-terminal-v1/11-week-5-plan.md
```

## Files changed

1. `.github/workflows/ci.yml` — added the `quality-gates-macos` tier-1 validation job alongside the existing Ubuntu job.
2. `README.md` — added the top-level `## Platform Support` section describing Linux tier-1, macOS tier-1, and Windows tier-2.
3. `design/20260319_agent-terminal-v1.md` — updated the design entrypoint shipped-status section to 2026-03-23 and linked Week 5 status/current gaps.
4. `design/20260319_agent-terminal-v1/12-week-5-status.md` — added the dedicated Week 5 status record documenting what shipped vs what remains future scope.
5. `design/20260319_agent-terminal-v1/11-week-5-plan.md` — updated the status section near the top to reflect the Week 5 outcome and cross-link the status doc.
6. `WEEK2-GAPS.md` — reclassified the tracker into the post-Week-5 gap list with shipped, scaffolded, and future-scope labels.

## What this proves

- macOS CI is configured in the maintained GitHub Actions workflow.
- Platform support tiers are documented in the top-level README.
- The design/docs entrypoints reflect the actual Week 5 state as of 2026-03-23.
- The remaining-gap tracker distinguishes shipped closures from scaffolded work and future scope instead of overstating completeness.

## Evidence files in this bundle

- `./ci-workflow.png`
- `./readme-platform-support.png`
- `./week5-status-summary.png`
- `./design-index-update.png`
- `./evidence-walkthrough.webm`

## Links to key docs

- `../../.github/workflows/ci.yml`
- `../../README.md`
- `../../design/20260319_agent-terminal-v1.md`
- `../../design/20260319_agent-terminal-v1/12-week-5-status.md`
- `../../design/20260319_agent-terminal-v1/11-week-5-plan.md`
- `../../WEEK2-GAPS.md`
