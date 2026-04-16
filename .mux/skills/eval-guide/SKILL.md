---
name: eval-guide
description: Guide for running statistically meaningful agent-tty evals with trials, parallelism, and A/B comparison. Covers non-determinism baseline, recommended sample sizes, and result interpretation.
---

# Eval Guide

Use this guide when you are trying to answer **"did this skill or prompt change actually help?"** for `agent-tty` evals.

The short version: **do not trust a single run**. This eval stack now supports multi-trial sampling, parallel execution, trial aggregation, and paired baseline comparison because the underlying model behavior is noisy enough that one pass/fail result is not decision-grade.

## 1. What we learned about eval non-determinism

- Identical serial reruns showed a **~15-17% pass/fail flip rate** in practice, across both Codex and Claude runs.
- Scores moved even more often than hard pass/fail: **~30-39% of identical reruns changed score**.
- The movement was directionally balanced, which is the important point: this looked like **noise**, not a systematic drift up or down.
- Cross-provider checks reinforced that conclusion: in the parallel safety analysis, **Codex and Claude shared zero common regressions**, which is strong evidence that parallelism itself was not introducing consistent failures.
- Treat these findings as the baseline noise floor. If your "improvement" is smaller than that noise, it is not persuasive.

## 2. Run evals with enough statistical power

Always set `--trials` for real prompt or skill experiments.

Recommended trial counts:

- **Prompt lane:** `--trials 5` to `--trials 10`
- **Execution lane:** `--trials 3`
- **Dogfood lane:** `--trials 2` to `--trials 3`

Use concurrency to keep those sample sizes affordable:

- Start with **`--concurrency 4`** for real-provider runs.
- Recent measurements showed about a **3.4x wall-clock speedup** at that setting.
- Leave `--concurrency 1` only when you explicitly want fully serial behavior.

When `--trials` is greater than `1`, reports automatically include **Trial Aggregation** in `report.md` and `report.json`, including per-case:

- pass rate,
- pass-rate confidence interval,
- mean score,
- score confidence interval,
- standard deviation,
- and min/max score.

## 3. Compare before vs. after a skill change

Use a paired baseline comparison whenever you want to know whether a change helped. The comparison report uses **paired bootstrap confidence intervals** and paired win/loss/tie counts, so it is much more reliable than eyeballing two single runs.

1. Run a **baseline** on the exact lane, cases, provider, model, and trial count you care about.
2. Save the baseline `report.json` path.
3. Make the skill or prompt change.
4. Run the **candidate** with `--compare-baseline <baseline-report-path>`.
5. Read the comparison verdicts: `improved`, `regressed`, or `inconclusive`.

Practical reading rules:

- Do **not** call something better just because the mean moved in the right direction.
- Treat a win as meaningful only when the paired CI excludes `0` **and** the effect is practically large enough to matter.
- In the current implementation, the practical cutoffs are **`0.05` score delta** and, for overall pass rate, **`0.05` absolute pass-rate delta**.
- Tiny but statistically significant deltas are still not worth celebrating.

A reliable prompt-lane A/B loop looks like this:

```bash
BASELINE_JSON=$(npx tsx evals/run.ts \
  --provider codex \
  --model gpt-5.4 \
  --lane prompt \
  --condition self-load \
  --trials 5 \
  --concurrency 4 \
  --output evals/reports/prompt-baseline \
  --json | jq -r '.jsonReportPath')

# edit the skill or prompt

npx tsx evals/run.ts \
  --provider codex \
  --model gpt-5.4 \
  --lane prompt \
  --condition self-load \
  --trials 5 \
  --concurrency 4 \
  --output evals/reports/prompt-candidate \
  --compare-baseline "$BASELINE_JSON" \
  --json
```

## 4. Interpret results correctly

- **`inconclusive` is the default, healthy outcome when nothing meaningful changed.** In our same-skill sanity check, **23 of 24 cases were inconclusive** and the paired win/loss/tie total was **14W / 15L / 43T**.
- A few false positives are normal. At **95% confidence**, a **~1 in 24** spurious finding in a 24-case sweep is not surprising even when nothing changed.
- Read **wins / losses / ties** alongside the CI. They give an intuitive sense of whether the candidate is consistently helping or just bouncing around.
- If a comparison is mostly ties with a wide CI, the result is noise-dominated; add more trials before making a claim.
- If you only have two standalone reports and no paired baseline comparison, diff them only after stripping timing- and path-specific fields. That can catch large shifts, but it is much less trustworthy than `--trials` plus `--compare-baseline`.

## 5. Concurrency is safe and should be used

- `--concurrency 1` remains the default and preserves serial behavior.
- **Parallelism did not introduce regressions** in the safety checks; observed parallel flip rates were at or below the normal serial noise floor.
- `--concurrency 4-20` is a reasonable operating range when provider limits and budget allow.
- The current runner can execute **all three lanes concurrently** when concurrency is above `1`.
- Execution and dogfood work items run in **isolated temp homes/output directories** and clean up in `finally` blocks, so parallel runs do not share session state.

Use serial mode only when debugging; use parallel mode when sampling.

## 6. Quick reference commands

### Prompt-lane experiment

```bash
npx tsx evals/run.ts \
  --provider claude \
  --model claude-opus-4-6 \
  --lane prompt \
  --condition self-load \
  --trials 5 \
  --concurrency 4 \
  --output evals/reports/prompt-self-load
```

### Execution-lane check after workflow changes

```bash
npx tsx evals/run.ts \
  --provider codex \
  --model gpt-5.4 \
  --lane execution \
  --case hello-prompt \
  --case resize-demo \
  --trials 3 \
  --concurrency 4 \
  --output evals/reports/execution-smoke
```

### Dogfood proof-bundle spot check

```bash
npx tsx evals/run.ts \
  --provider claude \
  --model claude-opus-4-6 \
  --lane dogfood \
  --case exploratory-qa \
  --case evidence-completeness \
  --trials 2 \
  --concurrency 4 \
  --output evals/reports/dogfood-sample
```

### Full before/after comparison

```bash
BASELINE_JSON=$(npx tsx evals/run.ts \
  --provider codex \
  --model gpt-5.4 \
  --lane all \
  --condition all \
  --trials 3 \
  --concurrency 4 \
  --output evals/reports/baseline \
  --json | jq -r '.jsonReportPath')

npx tsx evals/run.ts \
  --provider codex \
  --model gpt-5.4 \
  --lane all \
  --condition all \
  --trials 3 \
  --concurrency 4 \
  --output evals/reports/candidate \
  --compare-baseline "$BASELINE_JSON" \
  --json
```

### Plumbing smoke test

```bash
npx tsx evals/run.ts --provider stub --lane prompt --trials 3 --concurrency 4
```

Use `stub` to validate wiring, not to judge whether a real-provider prompt or skill change helped.
