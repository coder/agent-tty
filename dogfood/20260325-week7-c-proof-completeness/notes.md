# 2026-03-25 dogfood — Week 7 bundle C proof completeness inventory

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week7-c-proof-completeness/`
- **Inventory date:** `2026-03-25T19:56:37.094Z`
- **Total bundle count:** 40
- **Review pages present:** 6

## Scenario summary

This inventory proves that the dogfood proof-bundle ecosystem can be reviewed from the live filesystem: every immediate subdirectory under `dogfood/` is enumerated, core reviewer-facing files are checked for presence, and reviewer artifacts (screenshots, recordings, videos, snapshots) are counted with totals derived directly from the current bundle directories.

## Inventory table

| Bundle                              | commands.sh | notes.md | index.html | log count | screenshot count | videos/recordings |
| ----------------------------------- | ----------- | -------- | ---------- | --------: | ---------------: | ----------------- |
| 20260319-lifecycle                  | no          | yes      | no         |         0 |                6 | 0/0               |
| 20260319-nvim-demo                  | no          | yes      | no         |         0 |                6 | 0/0               |
| 20260319-resize-demo                | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260320-renderer-complete          | yes         | yes      | no         |         0 |                0 | 0/0               |
| 20260321-post-hardening-smoke       | yes         | yes      | no         |         0 |                0 | 0/0               |
| 20260321-week3-crash-retention      | yes         | no       | no         |         0 |                0 | 0/0               |
| 20260321-week3-renderer-complete    | yes         | no       | no         |         0 |                0 | 0/0               |
| 20260322-dogfood-alt-screen         | yes         | yes      | no         |        32 |                3 | 1/1               |
| 20260322-dogfood-color              | yes         | yes      | no         |        18 |                2 | 0/1               |
| 20260322-dogfood-crash              | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-dogfood-hello-prompt       | no          | yes      | no         |         0 |                1 | 1/1               |
| 20260322-dogfood-resize             | no          | yes      | no         |         0 |                1 | 1/1               |
| 20260322-dogfood-scrollback         | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-dogfood-unicode            | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-dogfood-week4-features     | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-global-cli-context         | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-lazyvim-scenario           | no          | no       | no         |         0 |                0 | 0/0               |
| 20260322-week4-cli-parity           | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-week4-failure-recovery     | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-week4-scrollback-review    | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260322-week4-unicode-review       | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260323-bugfix-resize              | no          | yes      | no         |         0 |                3 | 0/0               |
| 20260323-bugfix-scrollback          | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260323-week5-platform-closure     | no          | yes      | no         |         0 |                0 | 0/0               |
| 20260323-week5-recovery-host        | yes         | yes      | no         |         8 |                0 | 0/0               |
| 20260323-week5-recovery-renderer    | yes         | yes      | no         |        19 |                2 | 0/0               |
| 20260323-week5-recovery-replay      | yes         | yes      | no         |        11 |                2 | 0/1               |
| 20260323-week5-render-cells         | yes         | yes      | no         |         4 |                0 | 0/0               |
| 20260323-week5-render-cursor        | yes         | yes      | no         |         6 |                3 | 0/0               |
| 20260323-week5-render-fonts         | yes         | yes      | no         |         4 |                2 | 0/0               |
| 20260323-week5-render-timing        | yes         | yes      | no         |         6 |                0 | 0/3               |
| 20260323-week5-review-helper        | yes         | yes      | no         |         9 |                2 | 0/0               |
| 20260325-week6-a-cli-contract       | yes         | yes      | yes        |        14 |                0 | 0/0               |
| 20260325-week6-b-artifact-health    | yes         | yes      | yes        |        13 |                1 | 0/0               |
| 20260325-week6-c-failure-taxonomy   | yes         | yes      | yes        |        23 |                0 | 0/0               |
| 20260325-week6-d-review-surface     | yes         | yes      | yes        |        26 |                1 | 0/0               |
| 20260325-week7-a-cli-parity         | yes         | yes      | yes        |        28 |                1 | 1/1               |
| 20260325-week7-b-envelope-locks     | yes         | yes      | no         |         6 |                0 | 0/0               |
| 20260325-week7-c-proof-completeness | yes         | yes      | yes        |         7 |                0 | 0/0               |
| week5-config-parity                 | yes         | no       | no         |         0 |                0 | 0/0               |

## Week 7 completeness

The minimum completeness bar for a review-ready Week 7 proof bundle is: `commands.sh`, `notes.md`, `manifest.json`, `command-status.tsv`, `index.html`.

- **20260325-week7-a-cli-parity:** Meets the minimum completeness bar (`commands.sh`, `notes.md`, `manifest.json`, `command-status.tsv`, `index.html`). Missing today: none.
- **20260325-week7-b-envelope-locks:** Does not yet meet the minimum completeness bar (`commands.sh`, `notes.md`, `manifest.json`, `command-status.tsv`, `index.html`). Missing today: `index.html`.
- **20260325-week7-c-proof-completeness:** Meets the minimum completeness bar (`commands.sh`, `notes.md`, `manifest.json`, `command-status.tsv`, `index.html`). Missing today: none.
- **20260325-week7-d-review-surface-audit:** Not present in the live inventory captured on 2026-03-25T19:56:37.094Z. The lane is still in-flight outside this task, so there is no filesystem proof bundle to assess yet.

## Review surface coverage

Bundles with a generated review page today (6/40):

- `20260325-week6-a-cli-contract`
- `20260325-week6-b-artifact-health`
- `20260325-week6-c-failure-taxonomy`
- `20260325-week6-d-review-surface`
- `20260325-week7-a-cli-parity`
- `20260325-week7-c-proof-completeness`

## Gaps found

- **Missing review pages (`index.html`):** `20260319-lifecycle`, `20260319-nvim-demo`, `20260319-resize-demo`, `20260320-renderer-complete`, `20260321-post-hardening-smoke`, `20260321-week3-crash-retention`, `20260321-week3-renderer-complete`, `20260322-dogfood-alt-screen`, `20260322-dogfood-color`, `20260322-dogfood-crash`, `20260322-dogfood-hello-prompt`, `20260322-dogfood-resize`, `20260322-dogfood-scrollback`, `20260322-dogfood-unicode`, `20260322-dogfood-week4-features`, `20260322-global-cli-context`, `20260322-lazyvim-scenario`, `20260322-week4-cli-parity`, `20260322-week4-failure-recovery`, `20260322-week4-scrollback-review`, `20260322-week4-unicode-review`, `20260323-bugfix-resize`, `20260323-bugfix-scrollback`, `20260323-week5-platform-closure`, `20260323-week5-recovery-host`, `20260323-week5-recovery-renderer`, `20260323-week5-recovery-replay`, `20260323-week5-render-cells`, `20260323-week5-render-cursor`, `20260323-week5-render-fonts`, `20260323-week5-render-timing`, `20260323-week5-review-helper`, `20260325-week7-b-envelope-locks`, `week5-config-parity`.
- **Missing notes (`notes.md`):** `20260321-week3-crash-retention`, `20260321-week3-renderer-complete`, `20260322-lazyvim-scenario`, `week5-config-parity`.
- **Missing command transcripts (`commands.sh`):** `20260319-lifecycle`, `20260319-nvim-demo`, `20260319-resize-demo`, `20260322-dogfood-crash`, `20260322-dogfood-hello-prompt`, `20260322-dogfood-resize`, `20260322-dogfood-scrollback`, `20260322-dogfood-unicode`, `20260322-dogfood-week4-features`, `20260322-global-cli-context`, `20260322-lazyvim-scenario`, `20260322-week4-cli-parity`, `20260322-week4-failure-recovery`, `20260322-week4-scrollback-review`, `20260322-week4-unicode-review`, `20260323-bugfix-resize`, `20260323-bugfix-scrollback`, `20260323-week5-platform-closure`.
- **Missing manifests (`manifest.json`):** `20260320-renderer-complete`, `20260321-post-hardening-smoke`, `20260322-dogfood-crash`, `20260322-dogfood-scrollback`, `20260322-dogfood-unicode`, `20260322-dogfood-week4-features`, `20260322-global-cli-context`, `20260322-lazyvim-scenario`, `20260322-week4-cli-parity`, `20260322-week4-failure-recovery`, `20260322-week4-scrollback-review`, `20260322-week4-unicode-review`, `20260323-bugfix-resize`, `20260323-bugfix-scrollback`, `20260323-week5-platform-closure`, `week5-config-parity`.
- **Missing command ledgers (`command-status.tsv`):** `20260319-lifecycle`, `20260319-nvim-demo`, `20260319-resize-demo`, `20260320-renderer-complete`, `20260321-post-hardening-smoke`, `20260321-week3-crash-retention`, `20260321-week3-renderer-complete`, `20260322-dogfood-crash`, `20260322-dogfood-hello-prompt`, `20260322-dogfood-resize`, `20260322-dogfood-scrollback`, `20260322-dogfood-unicode`, `20260322-dogfood-week4-features`, `20260322-global-cli-context`, `20260322-lazyvim-scenario`, `20260322-week4-cli-parity`, `20260322-week4-failure-recovery`, `20260322-week4-scrollback-review`, `20260322-week4-unicode-review`, `20260323-bugfix-resize`, `20260323-bugfix-scrollback`, `20260323-week5-platform-closure`, `week5-config-parity`.

## Evidence pointers

- **Bundle discovery:** `logs/01-bundle-list.txt`
- **Per-bundle file presence and inventory counts:** `logs/02-file-counts.tsv`
- **Reviewer artifact counts and screenshot byte totals:** `logs/03-artifact-counts.tsv`
- **Machine-readable rollup for totals, review coverage, and gap lists:** `logs/04-summary.json`
- **Generated review page for this bundle:** `logs/05-review-bundle.txt`

## Browser Verification (Week 7 remediation)

Review page verified via `agent-browser` — see `screenshots/01-review-page-verified.png`.
