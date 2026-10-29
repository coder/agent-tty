# Batch

A user sends an ordered list of input and wait steps to one session in a single `batch` call. Each wait step only sees screens produced after the step before it (its Wait Baseline). The batch stops at the first failed step unless the user passes `--keep-going`.

## Sub-features

- `batch-steps` runs `type`, `paste`, `sendKeys`, `run` and `wait` steps in order.
- `batch-baseline` anchors each wait step to the event-log sequence of the step before it.
- `batch-fail-fast` stops at the first failed step and marks later steps `not-run`.
- `batch-keep-going` runs every step and reports each failure.
- `batch-file` reads the steps from a JSON file.
- `batch-invalid` rejects a malformed step before it runs anything.

## How to get to it (user POV)

- `agent-tty batch <id> '<JSON array of steps>'`.
- `agent-tty batch <id> --file <steps.json>`.
- Add `--keep-going` to either form.

## Driving it with att

Preconditions:

- `mkdir -p "$EVIDENCE/batch"` has run. The recipe saves its proof there.
- The baseline preconditions in the README hold.
- `H=$(att create --json -- node --import tsx test/fixtures/apps/hello-prompt/main.ts | jq -r .result.sessionId)`, and `att wait "$H" --regex 'READY>$' --scope cursor-line --timeout 10000 --json` matches.

- **All steps pass.** Run `att batch "$H" '[{"type":"one"},{"sendKeys":["Enter"]},{"wait":{"text":"ECHO: one","timeout":5000}}]' --json | tee "$EVIDENCE/batch/pass.json"`. Exit code 0. `.result.steps` has three entries with `status: "completed"`, and the wait step has `waitBaseline` equal to the `seq` of the `sendKeys` step and `matched: true`.
- **Fail fast.** Run `att batch "$H" '[{"wait":{"text":"never-there","timeout":500}},{"type":"two"}]' --json | tee "$EVIDENCE/batch/fail-fast.json"`. Exit code 11 (the failed step's `WAIT_TIMEOUT`), `.ok` is `true`, `.result.failedIndices` is `[0]`, and step 1 has `status: "not-run"`. A snapshot shows no `two` typed after the prompt.
- **Keep going.** Run `att batch "$H" '[{"wait":{"text":"never-there","timeout":300}},{"type":"three"},{"sendKeys":["Enter"]},{"wait":{"text":"ECHO: three","timeout":5000}}]' --keep-going --json`. Exit code 1. Step 0 is `failed`, and steps 1 to 3 are `completed`.
- **From a file.** Write `[{"type":"four"},{"sendKeys":["Enter"]},{"wait":{"text":"ECHO: four","timeout":5000}}]` to `$EVIDENCE/batch/steps.json` and run `att batch "$H" --file "$EVIDENCE/batch/steps.json" --json`. Exit code 0, three completed steps.
- **Invalid step.** Run `att batch "$H" '[{"type":"x"},{"wait":{"text":"y","timeoutMs":5}}]' --json`. Exit code 2, `.error.code` is `INVALID_INPUT`, `.error.details.stepIndex` is `1`, and a snapshot shows that step 0 did not type `x`.

## Gotchas

- The wait step's time-out key is `timeout`, not `timeoutMs`. An unknown key rejects the whole batch with `INVALID_INPUT`.
- A wait step without `timeout` waits up to 10 minutes.
- A failed batch still prints `"ok": true`: the envelope reports the batch, and the exit code and `failedIndices` report the failure. Check both.
- Wait Baselines keep a wait step from matching an older screen, but text that the program printed earlier can still be on the screen. Wait for text that only the new output contains.
