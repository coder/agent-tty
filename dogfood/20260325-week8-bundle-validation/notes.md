# 2026-03-25 dogfood — Week 8 bundle validation proof

## Bundle metadata

- **Bundle path:** `dogfood/20260325-week8-bundle-validation/`
- **Validation helper:** `npm run validate-bundle -- <bundle-dir> [--profile <profile>]`
- **Reference review helper:** `npm run review-bundle -- <bundle-dir>`
- **Proof date:** `2026-03-25`
- **Profiles covered:** `contract-reporting` directly, with `interactive-renderer` requirements documented for comparison

## Scenario summary

This bundle proves the Week 8 `validate-bundle` helper against four scenarios: a minimal valid sample bundle created under `/tmp`, an intentionally invalid sample bundle created under `/tmp`, the task brief's suggested `dogfood/20260325-week7-a-cli-parity/` reference bundle, and a reviewed temp copy of the existing `dogfood/20260319-lifecycle/` bundle. It also validates this Week 8 proof bundle itself after generating its review page and reviewer screenshot.

## Validation profile summary

- **`contract-reporting`:** requires the bundle directory to exist, at least one JSON output file, at least one notes markdown file, a generated `index.html` review page, and JSON that parses successfully.
- **`interactive-renderer`:** includes every `contract-reporting` check plus at least one screenshot artifact and at least one `.cast` recording artifact.
- **Important implementation detail:** the current validator classifies everything under `logs/` as support files before it checks for `.json`, so `logs/*.json` do **not** satisfy the `has-json-output` requirement by themselves.

## Proof results

- **Valid sample passes:** `logs/01-valid-pass.json` shows a temporary sample bundle that contains a root-level `01-sample.json`, `notes.md`, and a generated `index.html`, so every contract-reporting check passes.
- **Invalid sample fails as expected:** `logs/02-invalid-fail.json` shows the intentionally empty sample bundle fails `has-json-output`, `has-review-page`, `has-notes`, and `json-readable`. `command-status.tsv` records the non-zero exit code as `expected-fail`.
- **Brief reference bundle currently fails:** `logs/03-brief-reference-week7-a-fail.json` shows `dogfood/20260325-week7-a-cli-parity/` does **not** currently satisfy `contract-reporting`, because its JSON evidence lives under `logs/`, which the validator treats as support files instead of JSON output.
- **Existing reviewed legacy bundle passes:** `logs/04-existing-legacy-pass.json` proves a temporary reviewed copy of the existing `dogfood/20260319-lifecycle/` bundle passes contract-reporting once it has an `index.html` review page.
- **This Week 8 bundle passes contract-reporting:** `logs/06-self-pass.json` proves the proof bundle itself has valid JSON evidence (`proof-summary.json`), notes, and a generated review page.

## Why each case behaves correctly

- **Why the valid sample passes:** it has a parseable root JSON file (`01-sample.json`), a notes file (`notes.md`), and a generated review page (`index.html`).
- **Why the invalid sample fails:** it intentionally omits notes, JSON output, and the review page, so the validator reports multiple failed checks instead of silently passing an incomplete bundle.
- **Why the Week 7-A reference fails today:** its numbered JSON evidence is stored under `logs/`, but the validator's classifier marks `logs/` artifacts as support files before it checks `.json`, so no JSON output is counted for contract-reporting.
- **Why the reviewed legacy copy passes:** the existing `20260319-lifecycle` bundle already contains root-level JSON output and notes, so adding a generated `index.html` in `/tmp` satisfies the remaining contract-reporting requirement without mutating the repository copy.
- **Why this proof bundle targets `contract-reporting`:** it includes a review-page screenshot (`screenshots/01-review-page.png`) as extra reviewer evidence, but it intentionally does not include a `.cast` recording artifact, so `interactive-renderer` would still be stricter than necessary for this documentation-focused proof.

## Review answers

- **Did the valid sample pass?** Yes. Step 01 exited successfully and the JSON result reports `ok: true`.
- **Did the invalid sample fail?** Yes. Step 02 exited non-zero and the JSON result reports `ok: false` with the expected missing-artifact checks.
- **Did the task brief's Week 7-A reference pass?** No. Step 03 documents the current-tool mismatch directly instead of hiding it.
- **Did any existing bundle pass?** Yes. Step 04 validated a reviewed temp copy of the existing `dogfood/20260319-lifecycle/` bundle successfully.
- **Did this bundle generate its own review page?** Yes. `logs/07-review-self.txt` records the final `review-bundle` run and `index.html` is present in the bundle root.
- **Was a reviewer screenshot captured?** Yes. `logs/05-review-page-screenshot.json` records the Playwright capture and `screenshots/01-review-page.png` is the resulting image.
- **Where is the JSON artifact that makes this bundle contract-reporting compliant?** `proof-summary.json` sits at the bundle root specifically because the current validator does not count `logs/*.json` as JSON output.
- **Where are the exit codes?** `command-status.tsv` records every step, including the expected failures.

## Issues / limitations

- The temporary sample bundles live under `/tmp` and are cleaned up at the end of each `commands.sh` run, so the durable proof is the captured validator output rather than the sample directories themselves.
- The task brief suggested `dogfood/20260325-week7-a-cli-parity/` as an existing passing reference, but the current validator rejects it for the concrete path-classification reason documented above.
- This bundle intentionally focuses on contract-reporting behavior. It documents the stricter interactive-renderer profile, but it does not try to manufacture a recording artifact solely to satisfy that higher bar.
