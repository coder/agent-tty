# Release process

`RELEASE.md` defines the shipping contract. This document describes how maintainers should validate and present that contract.

## Before cutting a release

1. Re-read [`../RELEASE.md`](../RELEASE.md) and confirm it still matches the shipped surface.
2. Re-read [`../ROADMAP.md`](../ROADMAP.md) and confirm deferred work is not mixed back into the release contract.
3. Verify the primary docs route correctly from [`../README.md`](../README.md) to release, roadmap, design, and dogfood materials.
4. Review [`../dogfood/CATALOG.md`](../dogfood/CATALOG.md) and make sure the release-signoff bundle is current and easy to find.

## Validation bar

Run the full repo validation command:

```bash
npm run verify
```

That command now includes the tarball packaging smoke plus a git-install caveat check, so release candidates exercise the guaranteed private-distribution path and record the current git-dependency behavior before publish.

If the public skill changed, also run:

```bash
npm run intent:validate
```

## Proof expectations

- Keep at least one current release-readiness bundle under `dogfood/`.
- Keep evergreen scenario bundles easy to discover from the dogfood catalog.
- When a change affects renderer, screenshot, wait, export, or review UX, include screenshots and recordings in the relevant proof bundle when feasible.
