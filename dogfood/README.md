# Dogfood proof bundles

This directory contains reviewer-facing proof bundles for `agent-tty`.
Some bundles are evergreen workflow scenarios, some are release/contract validation bundles, and many older date-stamped bundles are historical evidence from the v1 build-out.

## Start here

1. Read [`CATALOG.md`](./CATALOG.md) for the curated bundle map.
2. For the current release-signoff view, start with `dogfood/20260326-week9-release-readiness/`.
3. For the Phase 5 eval DX token-usage proof from commit `91a571de`, start with `dogfood/token-usage-phase5-proof/`.
4. For evergreen workflows, start with bundles such as `dogfood/run-command/`, `dogfood/20260322-dogfood-hello-prompt/`, and `dogfood/20260322-lazyvim-scenario/`.
5. For recovery and hardening behavior, use the recovery section in the catalog.

## How to treat the directory

- **Canonical scenarios** demonstrate workflows reviewers should expect to keep using.
- **Validation bundles** lock specific release or contract claims.
- **Recovery bundles** document crash/replay/reconciliation behavior.
- **Historical bundles** remain valuable context, but they are not all equally important for a new reviewer.

## Retention policy

- Prefer stable, named bundles when a scenario is evergreen and should stay discoverable.
- Keep release-signoff bundles date-stamped so the evidence trail remains explicit.
- Update [`CATALOG.md`](./CATALOG.md) whenever a bundle becomes a reviewer-facing reference point.
- Leave one-off historical bundles in place unless they are superseded and no longer referenced.

## Legacy helper scripts

`generate-week3-bundles.sh` is kept as a historical helper for the earlier week-3 proof set. It is not the main starting point for new reviewers.
