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
├── authoring/
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
├── providers/
│   ├── base.ts
│   ├── claude.ts
│   ├── codex.ts
│   └── fixtures.ts
├── reporters/
├── snapshots/
└── workspaces/
```

High-level roles:

- `authoring/` contains the fluent case builders and raw escape hatches.
- `lib/` contains schemas, scoring, report generation, matrix math, and artifact helpers.
- `prompt/`, `execution/`, and `dogfood/` each define a lane-specific case inventory plus a runner.
- `providers/` normalizes different model backends into one interface.
- `reporters/` contains lifecycle event types plus the built-in console, JSONL, and final-report reporters.
- `snapshots/` contains token snapshot fingerprinting, storage, and comparison logic.
- `workspaces/` contains preset registration, resolution, and built-in workspace presets.
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

#### Lane B readiness and renderer requirements

Lane B coverage is intentionally uneven today. Use the **readiness tier** to decide where to add smoke coverage next, and use the **renderer requirement** column to decide whether a failure is likely a skill regression or an environment problem.

- **`battle-tested`** — safest execution smoke cases today.
- **`non-renderer unproven`** — next expansion batch before spending more time on renderer-heavy cases. `export-proof` stays in this rollout bucket even though its required `.webm` export is renderer-backed.
- **`renderer-optional`** — the case can still pass without Playwright/Chromium, but renderer-backed artifacts are useful when available.
- **`renderer-required`** — failing Playwright/Chromium/ghostty-web checks should be treated as an `environment-blocked` result, not as a skill regression.

| Case ID           | Readiness tier          | Renderer requirement | Notes                                                                                                                    |
| ----------------- | ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `hello-prompt`    | `battle-tested`         | `none`               | Core create → input → wait → snapshot → cleanup loop.                                                                    |
| `crash-recovery`  | `battle-tested`         | `none`               | Core crash inspection and cleanup flow.                                                                                  |
| `run-command`     | `battle-tested`         | `none`               | Core programmatic input flow via `agent-tty run`.                                                                        |
| `resize-demo`     | `non-renderer unproven` | `none`               | Snapshot-only resize verifier; high-value next smoke target.                                                             |
| `alt-screen-demo` | `non-renderer unproven` | `none`               | Event-log plus snapshot proof still needs broader smoke coverage.                                                        |
| `scrollback-demo` | `non-renderer unproven` | `none`               | Scrollback snapshot proof still needs broader smoke coverage.                                                            |
| `unicode-grid`    | `non-renderer unproven` | `none`               | Semantic snapshot verifier still needs broader smoke coverage.                                                           |
| `export-proof`    | `non-renderer unproven` | `required`           | Still part of the next smoke batch, but the required `.webm` export is renderer-backed.                                  |
| `color-grid`      | `renderer-optional`     | `optional`           | Screenshot evidence is preferred when renderer support exists, but non-renderer verification can still satisfy the case. |
| `doctor-gated`    | `renderer-required`     | `required`           | Must run `doctor --json` first; missing renderer support blocks the required screenshot.                                 |

**Expansion order:** keep prioritizing `resize-demo`, `alt-screen-demo`, `scrollback-demo`, `unicode-grid`, and `export-proof` before spending more time on `color-grid` or `doctor-gated`. Within that batch, `export-proof` is the one case that still needs renderer-backed WebM export, so preflight renderer availability first.

To avoid mistaking a missing browser/runtime dependency for a skill regression, pair execution-lane dry runs with a renderer preflight:

```sh
# Preview the case/condition matrix
npx tsx evals/run.ts --provider stub --lane execution --dry-run

# Check renderer prerequisites before renderer-backed cases
npx tsx src/cli/main.ts doctor --json

# If doctor reports a missing Playwright browser cache
npx playwright install chromium
```

`--dry-run` currently tells you which execution cases and conditions will run, but it does not yet annotate renderer needs inline. Use the table above to decide whether `color-grid`, `export-proof`, or `doctor-gated` should be treated as renderer-backed for your environment.

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

### Authoring evals with the façade

Case authoring previously required hand-assembling strict schema objects and parsing them by hand. The fluent builders in [`./authoring/`](./authoring/) keep the same validation guarantees, but make it much easier to add workflow checks, verifiers, report requirements, and workspace presets incrementally. Start with [`./authoring/index.ts`](./authoring/index.ts); the lane-specific builders live in [`./authoring/prompt.ts`](./authoring/prompt.ts), [`./authoring/execution.ts`](./authoring/execution.ts), and [`./authoring/dogfood.ts`](./authoring/dogfood.ts).

The snippets below assume you are creating a new file beside the canonical cases in the matching `evals/<lane>/cases/` directory.

<details>
<summary>Prompt lane (<code>wait-for-output</code>) — before vs. after</summary>

Before (equivalent raw schema object):

```ts
import { PromptEvalCaseSchema } from '../../lib/schemas.js';
import type { PromptEvalCase } from '../../lib/types.js';

const PROMPT_TIMEOUT_MS = 30_000;
const SLEEP_RECOMMENDATION_PATTERN = String.raw`/(?:^|\n)\s*sleep\s+\d+(?:\.\d+)?\b|(?:(?<=\buse\s)|(?<=\brun\s)|(?<=\badd\s)|(?<=\binsert\s))sleep\s+\d+(?:\.\d+)?\b/i`;

function requiredCheck(
  id: string,
  description: string,
  requiredPatterns: string[],
  forbiddenPatterns: string[] = [],
): PromptEvalCase['workflowChecks'][number] {
  return {
    id,
    description,
    required: true,
    requiredPatterns,
    forbiddenPatterns,
    dependsOn: [],
  };
}

export const waitForOutputCase: PromptEvalCase = PromptEvalCaseSchema.parse({
  id: 'wait-for-output',
  lane: 'prompt',
  category: 'trigger',
  prompt:
    "I need to wait until my server prints 'Listening on port 3000' before running tests",
  expectedSkill: 'agent-tty',
  context:
    'The answer should prefer waiting on observable terminal text over fixed delays before starting the next step.',
  expectedPatterns: ['/agent-tty/i', '/\\bwait\\b/i'],
  forbiddenPatterns: [SLEEP_RECOMMENDATION_PATTERN, '/setTimeout/i'],
  rubric: [
    'Chooses agent-tty for terminal readiness coordination.',
    'Uses wait against concrete terminal output instead of fixed timing guesses.',
  ],
  workflowChecks: [
    requiredCheck(
      'wait-for-output.select-agent-tty',
      'Explicitly selects agent-tty.',
      ['/agent-tty/i'],
    ),
    requiredCheck(
      'wait-for-output.observe-readiness',
      'Waits for the listening message before running tests.',
      ['/\\bwait\\b/i', '/Listening on port 3000/i'],
      [SLEEP_RECOMMENDATION_PATTERN, '/setTimeout/i'],
    ),
  ],
  antiPatterns: [],
  budgets: { timeoutMs: PROMPT_TIMEOUT_MS },
});
```

After (builder façade, matching [`./prompt/cases/trigger-agent-tty.ts`](./prompt/cases/trigger-agent-tty.ts)):

```ts
import { promptCase } from '../../authoring/index.js';
import type { PromptEvalCase } from '../../lib/types.js';

const PROMPT_TIMEOUT_MS = 30_000;
const EMPTY_ANTI_PATTERNS: PromptEvalCase['antiPatterns'] = [];
const SLEEP_RECOMMENDATION_PATTERN = String.raw`/(?:^|\n)\s*sleep\s+\d+(?:\.\d+)?\b|(?:(?<=\buse\s)|(?<=\brun\s)|(?<=\badd\s)|(?<=\binsert\s))sleep\s+\d+(?:\.\d+)?\b/i`;

export const waitForOutputCase = promptCase('wait-for-output')
  .category('trigger')
  .prompt(
    "I need to wait until my server prints 'Listening on port 3000' before running tests",
  )
  .expectSkill('agent-tty')
  .context(
    'The answer should prefer waiting on observable terminal text over fixed delays before starting the next step.',
  )
  .expectedPatterns(['/agent-tty/i', '/\\bwait\\b/i'])
  .forbiddenPatterns([SLEEP_RECOMMENDATION_PATTERN, '/setTimeout/i'])
  .rubric(
    'Chooses agent-tty for terminal readiness coordination.',
    'Uses wait against concrete terminal output instead of fixed timing guesses.',
  )
  .workflow((workflow) => {
    workflow
      .step('wait-for-output.select-agent-tty', 'Explicitly selects agent-tty.')
      .mustMention('/agent-tty/i');
    workflow
      .step(
        'wait-for-output.observe-readiness',
        'Waits for the listening message before running tests.',
      )
      .mustMention('/\\bwait\\b/i', '/Listening on port 3000/i')
      .mustNotMention(SLEEP_RECOMMENDATION_PATTERN, '/setTimeout/i');
  })
  .antiPatterns(...EMPTY_ANTI_PATTERNS)
  .budget(PROMPT_TIMEOUT_MS)
  .build();
```

</details>

<details>
<summary>Execution lane (<code>hello-prompt</code>) — before vs. after</summary>

Before (equivalent raw schema object):

```ts
import {
  ALL_EXECUTION_CONDITIONS,
  CREATE_SESSION_PATTERN,
  DESTROY_SESSION_PATTERN,
  SNAPSHOT_PATTERN,
  WAIT_PATTERN,
  anyOf,
  executionAntiPatterns,
  executionBudgets,
  executionTaskPrompt,
  fixtureSetupStep,
  requiredVerifier,
  workflowCheck,
} from './shared.js';
import { ExecutionEvalCaseSchema } from '../../lib/schemas.js';

const HELLO_WORLD_INPUT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\b(?:run|type)\b[^\n]*hello world`,
  String.raw`\b(?:run|type)(?:ning|s|ned)?\b[^\n]*hello world\b`,
  String.raw`ECHO:\s*hello world`,
);

export const helloPromptCase = ExecutionEvalCaseSchema.parse({
  id: 'hello-prompt',
  lane: 'execution',
  category: 'session',
  prompt: executionTaskPrompt(
    "Launch the hello-prompt fixture, send 'hello world' as input, wait for the READY> prompt to reappear, take a snapshot to verify the echo, then destroy the session.",
    'hello-prompt',
  ),
  expectedSkill: 'agent-tty',
  fixture: 'hello-prompt',
  conditions: [...ALL_EXECUTION_CONDITIONS],
  setup: [
    fixtureSetupStep(
      'launch-hello-prompt',
      'hello-prompt',
      'Create an agent-tty session that runs the hello-prompt fixture.',
    ),
  ],
  verifiers: [
    requiredVerifier(
      'hello-prompt-snapshot',
      'snapshot',
      'The transcript snapshot should include the echoed text and the READY prompt.',
      {
        patterns: [String.raw`ECHO:\s*hello world`, String.raw`READY>`],
      },
    ),
  ],
  workflowChecks: [
    workflowCheck(
      'create',
      'Create the fixture session.',
      CREATE_SESSION_PATTERN,
    ),
    workflowCheck(
      'input',
      'Send hello world with run or type.',
      HELLO_WORLD_INPUT_PATTERN,
      { dependsOn: ['create'] },
    ),
    workflowCheck(
      'wait',
      'Wait for the READY prompt to reappear after the echo.',
      anyOf(WAIT_PATTERN, String.raw`ECHO:\s*hello world[\s\S]*READY>`),
      { dependsOn: ['input'] },
    ),
    workflowCheck(
      'snapshot',
      'Capture a snapshot for verification.',
      SNAPSHOT_PATTERN,
      { dependsOn: ['wait'] },
    ),
    workflowCheck(
      'destroy',
      'Destroy the session after verification.',
      DESTROY_SESSION_PATTERN,
      { dependsOn: ['snapshot'] },
    ),
  ],
  antiPatterns: executionAntiPatterns(),
  artifactRequirements: [],
  budgets: executionBudgets({
    timeoutMs: 120_000,
    maxAgentSteps: 12,
    maxWallClockMs: 60_000,
  }),
  referenceSteps: 5,
  workspace: 'agent-tty-smoke',
});
```

After (builder façade, matching [`./execution/cases/hello-prompt.ts`](./execution/cases/hello-prompt.ts)):

```ts
import { executionCase } from '../../authoring/index.js';
import { ALL_EXECUTION_CONDITIONS, anyOf } from './shared.js';

const HELLO_WORLD_INPUT_PATTERN = anyOf(
  String.raw`\bagent-tty\b[^\n]*\b(?:run|type)\b[^\n]*hello world`,
  String.raw`\b(?:run|type)(?:ning|s|ned)?\b[^\n]*hello world\b`,
  String.raw`ECHO:\s*hello world`,
);

export const helloPromptCase = executionCase('hello-prompt')
  .category('session')
  .task(
    "Launch the hello-prompt fixture, send 'hello world' as input, wait for the READY> prompt to reappear, take a snapshot to verify the echo, then destroy the session.",
  )
  .fixture('hello-prompt', {
    setupId: 'launch-hello-prompt',
    setupDescription:
      'Create an agent-tty session that runs the hello-prompt fixture.',
  })
  .referenceSteps(5)
  .conditions(...ALL_EXECUTION_CONDITIONS)
  .assertions((assertions) => {
    assertions.snapshot(
      'hello-prompt-snapshot',
      'The transcript snapshot should include the echoed text and the READY prompt.',
      {
        patterns: [String.raw`ECHO:\s*hello world`, String.raw`READY>`],
      },
    );
  })
  .workflow((workflow) => {
    workflow
      .createSession()
      .input('hello world', {
        description: 'Send hello world with run or type.',
        pattern: HELLO_WORLD_INPUT_PATTERN,
      })
      .waitFor(String.raw`ECHO:\s*hello world[\s\S]*READY>`, {
        description: 'Wait for the READY prompt to reappear after the echo.',
      })
      .snapshot()
      .destroy();
  })
  .budget({
    timeoutMs: 120_000,
    maxAgentSteps: 12,
    maxWallClockMs: 60_000,
  })
  .workspace('agent-tty-smoke')
  .build();
```

</details>

<details>
<summary>Dogfood lane (<code>exploratory-qa</code>) — before vs. after</summary>

Before (equivalent raw schema object):

```ts
import {
  artifactRequirement,
  requiredVerifier,
} from '../../execution/cases/shared.js';
import { DEFAULT_ANTI_PATTERN_RULES } from '../../lib/antiPatterns.js';
import { SKILL_CONDITIONS } from '../../lib/matrix.js';
import { DogfoodEvalCaseSchema } from '../../lib/schemas.js';
import { dogfoodTaskPrompt } from './shared.js';

const SCREENSHOT_BUNDLE_PATH_PATTERN = String.raw`\.png$`;
const RECORDING_BUNDLE_PATH_PATTERN = String.raw`\.cast$`;
const NOTES_BUNDLE_PATH_PATTERN = String.raw`(?:^|/)(?:README|NOTES|index|notes)\.md$`;
const TITLE_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Title\b|\*\*Title:?\*\*)/im`;
const REPRODUCTION_SECTION_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Reproduction steps|Repro(?:duction)? steps|Steps)\b|\*\*(?:Reproduction steps|Repro(?:duction)? steps|Steps):?\*\*)/im`;
const FINDINGS_SECTION_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*(?:Findings|Issues)\b|\*\*(?:Findings|Issues):?\*\*)/im`;
const EVIDENCE_SECTION_PATTERN = String.raw`/(?:^|\n)\s*(?:#{1,3}\s*Evidence\b|\*\*Evidence:?\*\*)/im`;
const CLI_REFERENCE_PATTERN = String.raw`/\b(?:agent-tty|npx\s+tsx\s+src\/cli\/main\.ts)\b/i`;
const SEVERITY_PATTERN = String.raw`/\b(?:severity|critical|high|medium|low|info)\b/i`;
const EVIDENCE_REFERENCE_PATTERN = String.raw`/\.(?:png|cast|webm|json|md)\b/i`;

export const exploratoryQaCase = DogfoodEvalCaseSchema.parse({
  id: 'exploratory-qa',
  lane: 'dogfood',
  category: 'qa',
  prompt: dogfoodTaskPrompt(
    'Launch the hello-prompt fixture, test exactly three inputs (`hello world`, a blank line, and `symbols-!@#$%^&*`), capture a snapshot after each input, then send `exit` to verify clean shutdown. Save at least one screenshot and one recording, and write a brief findings report with severity and evidence references.',
    'hello-prompt',
  ),
  expectedSkill: 'dogfood-tui',
  fixture: 'hello-prompt',
  bundlePath: 'proof-bundle',
  bundleRequirements: [
    'Produce a reviewable proof bundle for an exploratory QA investigation.',
    'Capture renderer-backed evidence for the tested interactions and edge cases.',
    'Write structured notes that summarize findings, severity, and evidence references.',
  ],
  conditions: [...SKILL_CONDITIONS],
  validationProfile: 'interactive-renderer',
  artifactRequirements: [
    artifactRequirement(
      'screenshot',
      'Capture at least one screenshot of a noteworthy state.',
      SCREENSHOT_BUNDLE_PATH_PATTERN,
    ),
    artifactRequirement(
      'recording',
      'Capture at least one terminal recording artifact.',
      RECORDING_BUNDLE_PATH_PATTERN,
    ),
    artifactRequirement(
      'notes',
      'Write exploratory QA notes in a markdown report.',
      NOTES_BUNDLE_PATH_PATTERN,
    ),
  ],
  reportRequirements: [
    {
      id: 'title',
      description: 'Report must have a descriptive title.',
      required: true,
      section: 'Title',
      requiredPatterns: [TITLE_PATTERN],
      forbiddenPatterns: [],
    },
    {
      id: 'repro-steps',
      description: 'Include step-by-step reproduction commands.',
      required: true,
      section: 'Reproduction steps',
      requiredPatterns: [REPRODUCTION_SECTION_PATTERN, CLI_REFERENCE_PATTERN],
      forbiddenPatterns: [],
    },
    {
      id: 'findings',
      description: 'List findings with severity classification.',
      required: true,
      section: 'Findings',
      requiredPatterns: [FINDINGS_SECTION_PATTERN, SEVERITY_PATTERN],
      forbiddenPatterns: [],
    },
    {
      id: 'evidence',
      description:
        'Reference captured artifacts such as screenshots and recordings.',
      required: true,
      section: 'Evidence',
      requiredPatterns: [EVIDENCE_SECTION_PATTERN, EVIDENCE_REFERENCE_PATTERN],
      forbiddenPatterns: [],
    },
  ],
  verifiers: [
    requiredVerifier(
      'bundle-valid',
      'bundle',
      'Validate the exploratory QA proof bundle with the interactive renderer profile.',
      { profile: 'interactive-renderer' },
    ),
  ],
  workflowChecks: [],
  antiPatterns: DEFAULT_ANTI_PATTERN_RULES.map((rule) => ({
    ...rule,
    patterns: [...rule.patterns],
    ...(rule.lanes === undefined ? {} : { lanes: [...rule.lanes] }),
  })),
  budgets: {
    timeoutMs: 600_000,
    maxAgentSteps: 30,
    maxWallClockMs: 600_000,
  },
  workspace: 'agent-tty-smoke',
});
```

After (builder façade, matching [`./dogfood/cases/exploratory-qa.ts`](./dogfood/cases/exploratory-qa.ts)):

```ts
import { dogfoodCase } from '../../authoring/index.js';
import { SKILL_CONDITIONS } from '../../lib/matrix.js';

export const exploratoryQaCase = dogfoodCase('exploratory-qa')
  .category('qa')
  .task(
    'Launch the hello-prompt fixture, test exactly three inputs (`hello world`, a blank line, and `symbols-!@#$%^&*`), capture a snapshot after each input, then send `exit` to verify clean shutdown. Save at least one screenshot and one recording, and write a brief findings report with severity and evidence references.',
  )
  .fixture('hello-prompt')
  .bundlePath('proof-bundle')
  .bundleRequirements([
    'Produce a reviewable proof bundle for an exploratory QA investigation.',
    'Capture renderer-backed evidence for the tested interactions and edge cases.',
    'Write structured notes that summarize findings, severity, and evidence references.',
  ])
  .conditions(...SKILL_CONDITIONS)
  .validationProfile('interactive-renderer')
  .proofBundle((bundle) => {
    bundle.requiresScreenshot();
    bundle.requiresRecording();
    bundle.requiresNotes();
  })
  .report((report) => {
    report.title();
    report.reproductionSteps();
    report.findingsWithSeverity();
    report.evidenceReferences();
  })
  .bundleVerifier(
    'bundle-valid',
    'Validate the exploratory QA proof bundle with the interactive renderer profile.',
  )
  .budget({
    timeoutMs: 600_000,
    maxAgentSteps: 30,
    maxWallClockMs: 600_000,
  })
  .workspace('agent-tty-smoke')
  .build();
```

</details>

When the sugar is not enough, use the raw escape hatches from [`./authoring/raw.ts`](./authoring/raw.ts) or the matching builder methods:

- `rawWorkflowCheck(check)` — drop in a fully shaped `WorkflowCheck` when you need a dependency graph, weight, or regex combination that the helper DSL does not express cleanly.
- `rawVerifier(verifier)` — add an exact `VerifierSpec` when the assertion helpers do not cover the verifier kind or config you need.
- `rawArtifactRequirement(requirement)` — add an explicit `ArtifactRequirement` when `.artifact()` or `.proofBundle()` is not expressive enough.
- `rawReportRequirement(requirement)` — add an exact dogfood `ReportRequirement` when the section helpers in [`./authoring/report.ts`](./authoring/report.ts) do not fit the report structure you want.

Migration guidance: old case files continue to work. Prefer opportunistic migrations when you are already editing a case anyway; there is no requirement to rewrite the remaining schema-authored cases first.

### Workspace presets

Workspace presets live in [`./workspaces/types.ts`](./workspaces/types.ts) and [`./workspaces/registry.ts`](./workspaces/registry.ts). A `WorkspacePreset` is a small declarative bundle of `id`, `mode`, `description`, optional `templateDir`, optional `cwd`, optional `env`, and optional `bootstrap` commands. For `isolated` presets, the harness creates a fresh eval home, optionally copies `templateDir` into it, resolves `cwd`, runs preset bootstrap steps, and then continues with the case's normal execution. The materialization path lives in [`./lib/cliHarness.ts`](./lib/cliHarness.ts) and the resolver/redaction rules live in [`./workspaces/resolver.ts`](./workspaces/resolver.ts).

The built-in smoke preset is registered from [`./workspaces/builtins.ts`](./workspaces/builtins.ts):

```ts
import process from 'node:process';

import type { WorkspacePreset } from './types.js';

export const AGENT_TTY_SMOKE_PRESET: WorkspacePreset = {
  id: 'agent-tty-smoke',
  mode: 'isolated',
  description: 'Deterministic local smoke preset for agent-tty evals.',
  bootstrap: [
    {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("agent-tty-smoke bootstrap ok\\n")'],
      description: 'agent-tty-smoke smoke-probe',
    },
  ],
};
```

`registerBuiltinPresets()` wires this preset into the CLI automatically, so cases can reference it by ID without extra setup.

Use it from an execution or dogfood case with `.workspace('agent-tty-smoke')`:

```ts
import { executionCase, dogfoodCase } from '../../authoring/index.js';

export const helloPromptCase = executionCase('hello-prompt')
  // ...
  .workspace('agent-tty-smoke')
  .build();

export const exploratoryQaCase = dogfoodCase('exploratory-qa')
  // ...
  .workspace('agent-tty-smoke')
  .build();
```

If you need a project-specific preset, register it before `runEvalCli()` is called:

```ts
import process from 'node:process';

import { runEvalCli } from './evals/run.js';
import { registerPreset } from './evals/workspaces/registry.js';
import type { WorkspacePreset } from './evals/workspaces/types.js';

const helloSmokePreset: WorkspacePreset = {
  id: 'hello-smoke',
  mode: 'isolated',
  description: 'Copy the hello-prompt fixture into the temp home and seed env.',
  templateDir: 'test/fixtures/apps/hello-prompt',
  cwd: '.',
  env: {
    APP_MODE: 'smoke',
    GITHUB_TOKEN: 'example-secret',
  },
  bootstrap: [
    {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello-smoke bootstrap ok\\n")'],
      description: 'workspace probe',
    },
  ],
};

registerPreset(helloSmokePreset);
await runEvalCli(process.argv.slice(2));
```

Merge order is fixed and intentional:

1. preset `env` is the base layer;
2. request-specific env overrides are layered on top at spawn time;
3. preset `bootstrap` runs before case-level `setup`.

There is no separate `.env()` builder hook for cases today — the override layer is the lane/runtime env that the harness injects when it creates the request (for example `AGENT_TTY_EVAL_OUTPUT_DIR` in execution or `EVAL_OUTPUT_DIR` / `EVAL_REQUESTED_BUNDLE_DIR` in dogfood). Reporter payloads only receive the redacted workspace summary on `case.start` (`presetId`, `cwd`, `env`, `bootstrapCount`); keys ending in `_TOKEN`, `_KEY`, `_SECRET`, or `_PASSWORD` are replaced with `[REDACTED]`, but the raw values are still used for bootstrap and provider spawn.

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
├── snapshots/                    # when --snapshot-update or --snapshot-check is used
│   └── <provider>-<model>.jsonl
└── <run-id>/
    ├── metadata.json
    ├── report.json
    ├── report.md
    └── <lane>/<caseId>/<condition>/token-usage.json
```

Reporter outputs such as JSONL can also live outside this tree if you point `--reporter-output` somewhere else. `token-usage.json` only appears when a provider emits token usage, and `snapshots/` only appears when you opt into snapshot update/check mode.

### Reporter lifecycle

The reporter system in [`./reporters/`](./reporters/) gives the runner a typed lifecycle instead of one hard-coded output path. The lifecycle is `run.start` → `lane.start` → `case.start` → `trial.start` → `trial.finish` → `case.finish` → `lane.finish` → `run.finish`. In code, the `Reporter` interface in [`./reporters/types.ts`](./reporters/types.ts) exposes matching hooks (`onRunStart`, `onLaneStart`, `onCaseStart`, `onTrialStart`, `onTrialFinish`, `onCaseFinish`, `onLaneFinish`, `onRunFinish`), and the built-in JSONL reporter in [`./reporters/jsonl.ts`](./reporters/jsonl.ts) serializes the same lifecycle with dotted event names.

Built-ins:

- [`./reporters/console.ts`](./reporters/console.ts) — human-readable progress on stderr.
- [`./reporters/jsonl.ts`](./reporters/jsonl.ts) — append-only machine-readable lifecycle events.
- [`./reporters/final-report.ts`](./reporters/final-report.ts) — adapter that writes the existing `report.json` and `report.md` files.

Common CLI combinations:

```sh
# Implicit default: final report files only
npx tsx evals/run.ts --provider stub --lane prompt

# Human-readable progress on stderr
npx tsx evals/run.ts --provider stub --lane execution --reporter console

# Sugar for the console reporter
npx tsx evals/run.ts --provider stub --lane execution --progress

# Append machine-readable lifecycle events to JSONL
npx tsx evals/run.ts \
  --provider stub \
  --lane execution \
  --reporter jsonl \
  --reporter-output evals/reports/execution-events.jsonl

# Combine reporters explicitly
npx tsx evals/run.ts \
  --provider stub \
  --lane execution \
  --reporter final \
  --reporter jsonl \
  --reporter-output evals/reports/execution-events.jsonl \
  --progress
```

When you do not pass `--reporter`, the runner still enables `final` by default so `report.json` and `report.md` are written. `--progress` only appends `console`; it does not disable `final`.

If you need a custom reporter, implement the `Reporter` interface and point your extension code at the payload types in [`./reporters/types.ts`](./reporters/types.ts):

```ts
import process from 'node:process';

import type { CaseFinishEvent, Reporter, RunStartEvent } from './types.js';

export class TimingReporter implements Reporter {
  public readonly name = 'timing';

  public onRunStart(event: RunStartEvent): void {
    process.stderr.write(`run ${event.runId} started\n`);
  }

  public onCaseFinish(event: CaseFinishEvent): void {
    process.stderr.write(
      `${event.lane}/${event.caseId}[${event.condition}] finished in ${event.durationMs}ms\n`,
    );
  }
}
```

The dispatcher in [`./reporters/dispatch.ts`](./reporters/dispatch.ts) validates every payload, redacts secret-like env keys recursively before calling reporters, and isolates failures per reporter. A broken reporter writes an error to stderr, but it does not abort the eval run or stop the other reporters from receiving the same event.

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
- optional `tokenReport` totals and snapshot-check results when token usage is available,
- and provider-comparison views when relevant.

### `report.md`

Contains the reviewer-oriented Markdown report generated by `generateMarkdownReport()`:

- executive summary,
- lane breakdown,
- provider comparison,
- condition comparison,
- failed cases,
- anti-pattern summary,
- completeness rollups,
- and token-usage tables (plus snapshot warnings when requested).

### Token usage + snapshots

If a provider emits `normalizedOutput.tokenUsage`, the run writes a `token-usage.json` sidecar under `<output-base>/<run-id>/<lane>/<caseId>/<condition>/token-usage.json` via [`./lib/artifacts.ts`](./lib/artifacts.ts), and the final JSON + Markdown reports both grow a `tokenReport` section via [`./lib/reporting.ts`](./lib/reporting.ts). This is descriptive metadata, not part of case scoring.

Token snapshots are an opt-in regression signal built on top of that data. The store and comparison logic live in [`./snapshots/store.ts`](./snapshots/store.ts) and [`./snapshots/compare.ts`](./snapshots/compare.ts). Snapshot identity is keyed by `(provider, model, lane, caseId, condition, caseFingerprint)`. The fingerprint in [`./snapshots/fingerprint.ts`](./snapshots/fingerprint.ts) hashes the semantic case definition, including prompt text and workflow checks, so changing either of those invalidates the old baseline. In practice the new row shows up as `new`, and the stale stored row may also appear as `orphaned` until you refresh the snapshot file.

Recommended CLI workflow:

```sh
# Establish or refresh the baseline
npx tsx evals/run.ts \
  --provider codex \
  --model gpt-5.4 \
  --lane execution \
  --case hello-prompt \
  --output evals/reports/snapshot-baseline \
  --snapshot-dir evals/reports/snapshots \
  --snapshot-update

# Check a later run against the same baseline file
npx tsx evals/run.ts \
  --provider codex \
  --model gpt-5.4 \
  --lane execution \
  --case hello-prompt \
  --output evals/reports/snapshot-check \
  --snapshot-dir evals/reports/snapshots \
  --snapshot-check \
  --snapshot-threshold 20
```

Guardrails:

- `--snapshot-update` and `--snapshot-check` are mutually exclusive.
- Snapshot regressions are warnings only. They are surfaced in `tokenReport.snapshotCheck` and the Markdown report, but they do not change `EvalResult.ok`, `report.json` pass/fail totals, or the CLI exit code on their own.
- There is intentionally no snapshot-enforcement flag in this phase.
- The snapshot store writes one JSONL file per `provider-model` pair under the snapshot directory. Use a stable `--snapshot-dir` if you want to compare runs over time; the default is `<output>/snapshots`.

Use `--json` when you want only the final run summary on stdout; the full report files are still written to disk.
