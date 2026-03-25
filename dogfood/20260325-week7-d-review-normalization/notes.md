# 2026-03-25 dogfood — Week 7 bundle D review normalization proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week7-d-review-normalization/`
- **Review helper:** `src/tools/review-bundle.ts`
- **Package version context:** `agent-terminal@0.1.0` from `package.json`
- **Single-bundle targets:** `20260325-week7-a-cli-parity` and `20260325-week7-b-envelope-locks`
- **Batch mirror contents:** `20260325-week6-a-cli-contract`, `20260325-week6-d-review-surface`, `20260325-week7-a-cli-parity`, and `20260325-week7-b-envelope-locks`

## Scenario summary

This bundle proves that the review-bundle helper works in both single-bundle mode and batch `--all` mode while keeping the real repository's Week 6 bundles untouched. Single-bundle runs refreshed the two Week 7 target bundles in place, batch mode ran only against a temporary mirror under `/tmp`, and the safety check confirmed that no real `dogfood/20260325-week6-*` path was modified.

## Single-bundle proof

- **Step 01:** `logs/01-review-single-a.txt` captured a successful single-bundle render for `dogfood/20260325-week7-a-cli-parity/`, and `screenshots/01-week7-a-review-page.png` is the browser proof of the generated review page.
- **Step 02:** `logs/02-review-single-b.txt` captured a successful single-bundle render for `dogfood/20260325-week7-b-envelope-locks/`, creating `dogfood/20260325-week7-b-envelope-locks/index.html` in the real repo as expected.
- **Warnings:** `logs/01-review-single-a.stderr.txt` and `logs/02-review-single-b.stderr.txt` are empty, so neither single-bundle run emitted warnings.

## Batch-mode proof

- **Mirror strategy:** `logs/03-review-batch.txt` records the temporary mirror path `/tmp/agent-terminal-week7-review.9yyqy2` plus the four copied bundles processed there.
- **Result:** The `--all` run generated one `index.html` file per mirrored bundle, including the mirrored Week 6 bundles, without touching the real repository tree.
- **Warnings:** `logs/03-review-batch.stderr.txt` contains only the expected `Building ...` progress lines and no warnings or failures.

## Week 6 safety verification

- `logs/06-week6-safety-diff.txt` captured `git diff --name-only` immediately after the real-repo review commands. The only tracked change at that checkpoint was `dogfood/20260325-week7-a-cli-parity/index.html`.
- `logs/08-git-status-final.txt` confirms the final dirty paths stay inside Week 7: modified `dogfood/20260325-week7-a-cli-parity/index.html`, untracked `dogfood/20260325-week7-b-envelope-locks/index.html`, and the new `dogfood/20260325-week7-d-review-normalization/` bundle.
- No `dogfood/20260325-week6-*` file appeared in either verification step, so no restore step was needed.

## Review answers

- **Did single-bundle mode succeed for each Week 7 bundle?** Yes. Steps 01 and 02 both exited successfully and wrote the expected `index.html` paths into their stdout logs.
- **Did batch mode succeed?** Yes. Step 03 rendered review pages for all four mirrored bundles inside the temporary mirror.
- **Were any warnings emitted?** Not for the Week 7 single-bundle runs or the batch mirror run. The first self-review run in `logs/04-review-self.stderr.txt` emitted expected missing-artifact warnings because `logs/08-git-status-final.txt`, `screenshots/02-week7-d-review-page.png`, and `command-status.tsv` had not been created yet when that first render occurred.
- **Were Week 6 files left untouched?** Yes. The Week 6 proof relies on the temp mirror for `--all`, and the real-repo diff/status checks never showed a Week 6 path.

## Issues / limitations

- The requested `npx tsx ...` entrypoint hit an environment-specific `mise` trust check in this child worktree, so the captured proof used the equivalent local binary `./node_modules/.bin/tsx` after installing dependencies.
- The initial self-review pass necessarily ran before every Week 7-D artifact existed, so its stderr sidecar documents expected missing-artifact warnings. A later refresh updates the final `index.html` after the bundle contents are in place.
- Batch proof intentionally used only a representative mirror subset (two Week 6 bundles plus the two Week 7 bundles) because the goal was to prove normalization and Week 6 safety, not to rewrite the entire real `dogfood/` tree.
