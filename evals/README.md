# Evals for `agent-tty`

## 1. Overview

The `evals/` tree measures whether an agent or provider uses `agent-tty` the way this repository intends.

It answers three related questions:

1. **Routing:** does the model recognize when `agent-tty` or `dogfood-tui` is the right workflow?
2. **Execution:** can it actually drive the fixture apps with the expected terminal workflow?
3. **Dogfooding:** can it produce reviewer-friendly proof bundles with reproducible evidence and structured reports?

The system is intentionally deterministic. It scores outputs with schemas, regexes, workflow checks, artifact checks, bundle validation, and anti-pattern detection instead of relying on a model judge.

## 2. Quick start

Run everything from the repository root.

```sh
# Stub provider (no external deps)
npx tsx evals/run.ts --provider stub --lane prompt

# Claude Code
npx tsx evals/run.ts --provider claude --lane prompt

# Codex
npx tsx evals/run.ts --provider codex --lane all

# Specific cases
npx tsx evals/run.ts --provider stub --lane execution --case hello-prompt --case resize-demo

# Compare conditions in one dry run
npx tsx evals/run.ts --provider stub --lane execution --condition none --condition preloaded --dry-run
```

Useful flags:

- `--condition <cond>` — `none`, `self-load`, `preloaded`, `stale`, or `all` (default: `all`). May be repeated.
- `--output <dir>` — output base directory (default: `evals/reports/{timestamp}`)
- `--dry-run` — list the case/condition matrix without invoking a provider
- `--json` — emit only a JSON summary to stdout
- `--verbose` — write per-lane progress logs to stderr

Examples:

```sh
# Preview the matrix without invoking a provider
npx tsx evals/run.ts --provider stub --lane all --dry-run

# Restrict to one condition
npx tsx evals/run.ts --provider stub --lane prompt --condition self-load

# Compare two conditions in one run
npx tsx evals/run.ts --provider stub --lane prompt --condition none --condition preloaded

# Write results under a custom directory
npx tsx evals/run.ts --provider stub --lane execution --output evals/reports/local-smoke
```

## 3. Architecture

### Lane A — prompt

The prompt lane is a routing and planning eval. It checks whether the provider:

- picks the right skill (`agent-tty`, `dogfood-tui`, or `none`),
- mentions the expected workflow,
- avoids forbidden patterns,
- and avoids known terminal automation anti-patterns.

`runPromptLane()` executes plan-mode requests and scores the returned text with deterministic regex and workflow checks.

### Lane B — execution

The execution lane is a closed-loop fixture eval. It runs terminal tasks against deterministic fixture apps and checks:

- provider invocation success,
- required verifiers,
- workflow compliance,
- artifact requirements,
- and anti-pattern avoidance.

`runExecutionLane()` is where the repo proves that the recommended workflow is not just described, but actually executed.

### Lane C — dogfood

The dogfood lane evaluates exploratory QA and proof-bundle quality. It asks the provider to test a fixture like a reviewer would and then scores:

- bundle completeness,
- report completeness,
- evidence quality,
- taxonomy usage,
- and reproducibility.

`runDogfoodLane()` is the most workflow-heavy lane because it cares about evidence, reporting, and bundle structure rather than only command correctness.

### Skill conditions

Each lane can be run under four skill-loading conditions:

| Condition   | Meaning                                            | Why it matters                                                              |
| ----------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| `none`      | No skill text is preloaded.                        | Baseline behavior without assistance.                                       |
| `self-load` | Only a bootstrap `agent-tty` prompt is preloaded.  | Measures whether the model can route itself to the right specialized skill. |
| `preloaded` | The canonical specialized skill is already loaded. | Upper-bound/oracle condition for the intended workflow.                     |
| `stale`     | A stale or mismatched skill is preloaded.          | Measures harm from outdated guidance.                                       |

### Provider abstraction

Providers implement one shared interface in `evals/providers/base.ts`:

- `detect()` — runtime discovery and default model info
- `invokePlanMode()` — prompt-lane execution
- `invokeAgentMode()` — execution/dogfood execution
- `parse()` — normalization of raw provider output

`evals/run.ts` creates one provider, runs the selected lanes, and then emits JSON + Markdown reports from the normalized `EvalResult[]` stream.

## 4. Directory layout

```text
evals/
├── README.md
├── run.ts
├── lib/
│   ├── antiPatterns.ts
│   ├── artifacts.ts
│   ├── bundleScoring.ts
│   ├── cliHarness.ts
│   ├── matrix.ts
│   ├── reporting.ts
│   ├── schemas.ts
│   ├── scoring.ts
│   └── types.ts
├── prompt/
│   ├── cases/
│   └── runner.ts
├── execution/
│   ├── cases/
│   ├── verifiers/
│   └── runner.ts
├── dogfood/
│   ├── cases/
│   ├── scorers/
│   └── runner.ts
└── providers/
    ├── base.ts
    ├── claude.ts
    ├── codex.ts
    └── fixtures.ts
```

High-level roles:

- `lib/` contains schemas, scoring, report generation, matrix math, and artifact helpers.
- `prompt/`, `execution/`, and `dogfood/` each define a lane-specific case inventory plus a runner.
- `providers/` normalizes different model backends into one interface.
- `run.ts` is the top-level orchestrator for CLI usage.

## 5. Case inventory

### Prompt lane

Prompt cases currently cover positive routing, negative routing, and explicit anti-pattern prompts.

| Case ID               | Category       | Expected skill | Description                                                                     |
| --------------------- | -------------- | -------------- | ------------------------------------------------------------------------------- |
| `session-creation`    | `trigger`      | `agent-tty`    | Create a long-lived terminal session and capture build output.                  |
| `interactive-cli`     | `trigger`      | `agent-tty`    | Automate an interactive installer that needs prompt-aware input.                |
| `wait-for-output`     | `trigger`      | `agent-tty`    | Wait for a specific readiness string before continuing.                         |
| `snapshot-inspection` | `trigger`      | `agent-tty`    | Inspect terminal state with a semantic snapshot.                                |
| `screenshot-capture`  | `trigger`      | `agent-tty`    | Capture a reviewable screenshot of a TUI state.                                 |
| `recording-export`    | `trigger`      | `agent-tty`    | Export a terminal session as a shareable recording or video.                    |
| `cli-workflow-test`   | `trigger`      | `agent-tty`    | Test a CLI by driving multiple commands and checks.                             |
| `resize-verification` | `trigger`      | `agent-tty`    | Verify that a TUI handles terminal resize correctly.                            |
| `exploratory-testing` | `trigger`      | `dogfood-tui`  | Explore a TUI, find issues, and attach evidence.                                |
| `bug-hunting`         | `trigger`      | `dogfood-tui`  | Run a broad bug hunt for rendering, input, and edge cases.                      |
| `release-readiness`   | `trigger`      | `dogfood-tui`  | Produce a release-readiness quality report for a TUI.                           |
| `ux-review`           | `trigger`      | `dogfood-tui`  | Review navigation, responsiveness, and visual consistency.                      |
| `issue-reproduction`  | `trigger`      | `dogfood-tui`  | Reproduce a reported TUI crash and capture evidence.                            |
| `regression-triage`   | `trigger`      | `dogfood-tui`  | Check whether a known regression is still present.                              |
| `pure-reasoning`      | `trigger`      | `none`         | Linux process-scheduling question that should not trigger tooling.              |
| `code-review`         | `trigger`      | `none`         | Source review request that should stay in normal coding mode.                   |
| `file-editing`        | `trigger`      | `none`         | File-edit request that does not need terminal automation.                       |
| `web-development`     | `trigger`      | `none`         | React component authoring task that does not need `agent-tty`.                  |
| `documentation`       | `trigger`      | `none`         | API documentation request that should not route to a skill.                     |
| `git-operations`      | `trigger`      | `none`         | Git workflow request that should stay outside terminal automation eval routing. |
| `blind-sleep`         | `anti-pattern` | `agent-tty`    | Tempts the provider to use brittle `sleep` instead of waiting on state.         |
| `tmux-usage`          | `anti-pattern` | `agent-tty`    | Tempts the provider to use `tmux` instead of `agent-tty`.                       |
| `screen-usage`        | `anti-pattern` | `agent-tty`    | Tempts the provider to use `screen` instead of `agent-tty`.                     |
| `adhoc-screenshots`   | `anti-pattern` | `agent-tty`    | Tempts the provider to use `scrot`/`import`/similar screenshot tools.           |

### Execution lane

| Case ID           | Category   | Fixture           | Conditions | Description                                                                        |
| ----------------- | ---------- | ----------------- | ---------- | ---------------------------------------------------------------------------------- |
| `hello-prompt`    | `session`  | `hello-prompt`    | all four   | Launch the fixture, send `hello world`, wait for `READY>`, snapshot, and clean up. |
| `resize-demo`     | `tui`      | `resize-demo`     | all four   | Resize from the default size to `100x30` and verify the reported dimensions.       |
| `alt-screen-demo` | `tui`      | `alt-screen-demo` | all four   | Capture evidence for alt-screen entry and main-screen restoration.                 |
| `color-grid`      | `artifact` | `color-grid`      | all four   | Wait for the grid to render and capture a screenshot artifact.                     |
| `unicode-grid`    | `artifact` | `unicode-grid`    | all four   | Verify Unicode rendering with a semantic snapshot.                                 |
| `scrollback-demo` | `tui`      | `scrollback-demo` | all four   | Capture scrollback evidence showing early and late buffer lines.                   |
| `crash-recovery`  | `recovery` | `crash-demo`      | all four   | Observe a crashing fixture, inspect status, and clean up the session.              |
| `export-proof`    | `artifact` | `hello-prompt`    | all four   | Export the session as both asciicast and WebM artifacts.                           |
| `run-command`     | `session`  | `hello-prompt`    | all four   | Use `agent-tty run` instead of simulated typing, then snapshot the result.         |
| `doctor-gated`    | `artifact` | `hello-prompt`    | all four   | Run `doctor --json` before taking a renderer-dependent screenshot.                 |

### Dogfood lane

| Case ID                  | Category            | Fixture           | Conditions | Description                                                                                          |
| ------------------------ | ------------------- | ----------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `exploratory-qa`         | `qa`                | `hello-prompt`    | all four   | Run exploratory QA, collect screenshots/recordings, and write structured findings.                   |
| `release-readiness`      | `release-readiness` | `color-grid`      | all four   | Evaluate color rendering across modes and produce a ship-or-hold report.                             |
| `rendering-bug-repro`    | `bug-repro`         | `unicode-grid`    | all four   | Reproduce narrow-width combining-character corruption with before/after evidence.                    |
| `navigation-focus-repro` | `bug-repro`         | `hello-prompt`    | all four   | Reproduce a suspected paste/focus input issue and classify it with the taxonomy.                     |
| `resize-regression`      | `bug-repro`         | `resize-demo`     | all four   | Triage stale resize output with evidence at initial, resized, and restored states.                   |
| `evidence-completeness`  | `reporting`         | `scrollback-demo` | all four   | Produce the fullest possible proof bundle: screenshots, cast, WebM, snapshots, notes, and checklist. |

## 6. Scoring

All scoring is deterministic.

### Prompt scoring

Prompt-lane scoring combines three positive components and then subtracts penalties:

- expected-pattern coverage: **0.4**
- skill-selection correctness: **0.4**
- workflow compliance: **0.2**
- forbidden-pattern penalty: **-0.1** per violation
- anti-pattern penalty: **-0.05** per finding

A prompt case only passes when all expected patterns match, no forbidden patterns fire, the inferred skill matches the expected skill, every required workflow check passes, and no anti-patterns are detected.

### Execution scoring

Execution-lane scoring builds a breakdown from:

- provider invocation success,
- required verifier pass rate,
- required workflow-check pass rate,
- anti-pattern avoidance,
- and artifact-requirement pass rate (when a case has required artifacts).

The execution case passes only when the provider call succeeds, all required verifiers pass, all required workflow checks pass, no error-severity anti-patterns are present, and all required artifacts exist.

### Dogfood scoring

Dogfood-lane scoring uses equal **20%** weights for:

- bundle completeness,
- report completeness,
- evidence quality,
- taxonomy usage,
- reproducibility.

A dogfood case passes only when the provider invocation succeeds, required report/workflow expectations are satisfied, no blocking anti-patterns are present, and the overall score is at least **0.6**.

### Anti-pattern detection and workflow compliance

Across lanes, the system explicitly looks for common workflow mistakes such as:

- blind `sleep` usage,
- `tmux` or `screen` instead of `agent-tty` sessions,
- ad hoc screenshot tools like `scrot`, `import`, or `xdotool`,
- missing `--json` on `agent-tty` commands,
- and session cleanup problems.

That means the evals reward not only “getting the answer” but following the repo’s intended automation workflow.

## 7. Comparison metrics

`evals/lib/matrix.ts` computes condition-to-condition metrics per provider × lane × case group.

| Metric              | Definition                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| `realizedSkillLift` | Mean(`self-load`) - Mean(`none`)                                                |
| `oracleSkillLift`   | Mean(`preloaded`) - Mean(`none`)                                                |
| `routingGap`        | `oracleSkillLift - realizedSkillLift`                                           |
| `staleSkillHarm`    | Mean(`none`) - Mean(`stale`)                                                    |
| `regressionRate`    | `1` when `self-load < none`, else `0`                                           |
| `unlockRate`        | `1` when `self-load > none`, else `0`                                           |
| `routingEfficiency` | `clamp(realizedSkillLift / oracleSkillLift, 0, 1)` when oracle lift is positive |

How to read them:

- **Realized lift** tells you how much self-routing helped in practice.
- **Oracle lift** tells you how much headroom exists when the right skill is already loaded.
- **Routing gap** is the remaining opportunity between current self-routing and the oracle condition.
- **Stale-skill harm** measures how much outdated preload hurts compared with no preload.
- **Regression/unlock rates** summarize whether self-loading regresses or unlocks success case-by-case.
- **Routing efficiency** normalizes realized lift against the oracle upper bound.

When you run only one condition, comparison sections are intentionally omitted because there is nothing meaningful to compare.

## 8. Provider support

### Stub provider

`stub` is the safest local smoke-test provider. It has no external dependencies and returns deterministic canned outputs.

### Fixture provider

`fixture` replays pre-recorded runtime/result payloads from a fixture directory. `evals/run.ts` expects that path in `EVAL_FIXTURE_DIR`.

### Claude Code adapter

`evals/providers/claude.ts` shells out to the `claude` CLI, supports runtime detection, plan mode, agent mode, transcript capture, and tool-call normalization when the provider output includes it.

### Codex adapter

`evals/providers/codex.ts` shells out to the `codex` CLI and exposes the same normalized surface: detection, plan mode, agent mode, transcript capture, and parsed tool-call output.

### Choosing a provider

- Use `stub` for fast local validation and CI smoke tests.
- Use `fixture` for deterministic replay-based experiments.
- Use `claude` or `codex` when you want real routing/execution behavior.

## 9. Adding cases

Case authors should follow a few rules:

1. **Validate with schemas.** New cases should be created through the existing helpers and parsed by the relevant Zod schema.
2. **Prefer fixtures over ambient state.** Execution and dogfood cases should target deterministic fixture apps so failures are attributable.
3. **Balance routing.** Prompt cases should include true positives, true negatives, and anti-pattern bait — not only “always trigger” prompts.
4. **Keep verifiers deterministic.** Prefer snapshots, screenshots, event-log checks, bundle validation, and explicit pattern matching over subjective judgment.
5. **Make workflow expectations explicit.** Add workflow checks for required steps like `wait`, `snapshot`, `doctor --json`, `record export`, or cleanup.
6. **Keep case IDs stable.** Reports, filtering, and comparisons all key off case IDs.

A practical authoring loop is:

1. add the case file,
2. register it in the lane runner,
3. run `npx tsx evals/run.ts --provider stub --lane <lane> --case <id> --dry-run`,
4. then run the real lane against `stub` or a real provider.

## 10. CI integration

A useful rollout pattern is to tier eval coverage by cost and stability.

### PR tier

Keep pull-request coverage cheap and deterministic:

```sh
npx tsx evals/run.ts --provider stub --lane prompt
npx tsx evals/run.ts --provider stub --lane execution --dry-run
```

### Nightly tier

Run broader smoke coverage with either `stub`, `fixture`, or one real provider on a smaller slice:

```sh
npx tsx evals/run.ts --provider stub --lane all
npx tsx evals/run.ts --provider codex --lane prompt --condition all
```

### Weekly tier

Use the expensive schedule for full condition-matrix comparisons and dogfood coverage:

```sh
npx tsx evals/run.ts --provider claude --lane all --condition all
npx tsx evals/run.ts --provider codex --lane all --condition all
```

Practical advice:

- gate real-provider jobs behind credentials and budget controls,
- keep `stub` coverage always-on,
- and use `--json` when another CI step needs to parse the summary.

## 11. Reports

Each run writes its outputs under the chosen output base directory in a run-specific subdirectory:

```text
<output-base>/
└── <run-id>/
    ├── metadata.json
    ├── report.json
    └── report.md
```

### `metadata.json`

Contains the normalized `RunMetadata` for the run:

- run ID and creation time,
- repo root,
- selected provider(s) and detected model(s),
- active lanes and conditions,
- trial count,
- and notes such as provider detection details or per-lane failures.

### `report.json`

Contains the machine-readable aggregate report generated by `generateJsonReport()`:

- top-level metadata,
- aggregate pass/fail and score metrics,
- condition comparison metrics,
- every normalized `EvalResult`,
- and provider-comparison views when relevant.

### `report.md`

Contains the reviewer-oriented Markdown report generated by `generateMarkdownReport()`:

- executive summary,
- lane breakdown,
- provider comparison,
- condition comparison,
- failed cases,
- anti-pattern summary,
- and completeness rollups.

Use `--json` when you want only the final run summary on stdout; the full report files are still written to disk.
