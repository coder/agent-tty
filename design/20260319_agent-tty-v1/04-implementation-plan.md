# agent-tty v1 implementation plan

This plan is written so a follow-up AI coding agent can execute against it directly.

It is intentionally specific about:

- implementation order,
- module boundaries,
- quality gates,
- validation strategy,
- and dogfooding checkpoints.

## 1. Target stack

### 1.1 Language and runtime

- **Language:** TypeScript
- **Runtime:** Node.js LTS
- **Process model:** one background host process per session

### 1.2 Recommended dependencies

Keep the initial dependency set small and explicit.

Core dependencies:

- `node-pty` for PTY lifecycle
- `ghostty-web` for reference rendering
- `playwright` for browser harness, screenshots, and replay video
- `commander` or `cac` for CLI parsing
- `zod` for config, protocol, and manifest validation
- `ulid` or equivalent for sortable IDs

Recommended dev dependencies:

- `typescript`
- `vitest`
- `tsx`
- `eslint`
- `prettier`

Do not add additional heavy frameworks unless a concrete gap appears.

## 2. Suggested repo structure

```text
src/
├── cli/
│   ├── main.ts
│   ├── commandContext.ts
│   ├── output.ts
│   └── commands/
├── host/
│   ├── hostMain.ts
│   ├── createHost.ts
│   ├── rpcServer.ts
│   ├── sessionState.ts
│   ├── eventLog.ts
│   ├── artifactManager.ts
│   └── lifecycle.ts
├── protocol/
│   ├── messages.ts
│   ├── schemas.ts
│   └── errors.ts
├── pty/
│   ├── createPty.ts
│   ├── keyEncoder.ts
│   ├── pasteEncoder.ts
│   └── resize.ts
├── renderer/
│   ├── backend.ts
│   ├── ghosttyWeb/
│   └── profiles/
├── storage/
│   ├── home.ts
│   ├── sessionPaths.ts
│   └── manifests.ts
├── config/
│   ├── defaults.ts
│   ├── configFile.ts
│   └── resolve.ts
└── util/
```

Test layout:

```text
test/
├── unit/
├── integration/
├── e2e/
└── fixtures/
    └── apps/
```

## 3. Build phases

V1 should be built in ordered phases.

Do not skip phases.

Each phase below includes:

- scope,
- deliverables,
- hard acceptance criteria,
- and a dogfooding gate.

## 4. Phase 0 — bootstrap and contracts

### Scope

Create the initial project scaffold and the fundamental types.

### Deliverables

- project scaffold,
- TypeScript config,
- lint/test formatting config,
- CLI entrypoint with `version` and `doctor` skeletons,
- protocol message types,
- config resolution skeleton,
- session path helpers,
- structured error catalog.

### Acceptance criteria

- `version` returns a valid JSON envelope.
- `doctor` can run a no-op baseline and return structured checks.
- all protocol schemas are validated by tests.
- session path helpers create deterministic paths under a temp home directory in tests.

### Dogfooding gate

- run `agent-tty version --json`,
- run `agent-tty doctor --json`,
- capture a screenshot of the CLI output,
- record a short terminal video showing both commands,
- store artifacts under `dogfood/phase-0/`.

## 5. Phase 1 — session lifecycle and PTY ownership

### Scope

Implement session creation, listing, inspection, destroy, and PTY spawn.

### Deliverables

- `create`
- `list`
- `inspect`
- `destroy`
- background host spawn mechanism
- PTY child spawn
- session metadata persistence
- exit-event recording

### Acceptance criteria

- creating a session starts a host and PTY child,
- listing shows the session,
- inspection reflects live child PID and status,
- destroy terminates the session cleanly,
- exited sessions remain inspectable,
- stale session metadata is detected and surfaced.

### Required tests

- create/list/inspect integration test,
- exit propagation test,
- destroy cleanup test,
- stale metadata reconciliation test,
- invalid session ID error test.

### Dogfooding gate

Use a trivial fixture app that prints a prompt and exits on `q`.

Required artifacts:

- JSON output from `create`, `inspect`, and `destroy`,
- screenshot of `list` while the session is running,
- short video showing create → inspect → destroy,
- brief notes describing any platform-specific issues.

## 6. Phase 2 — input, resize, signals, and event log

### Scope

Implement interactive controls and the append-only event log.

### Deliverables

- `type`
- `paste`
- `send-keys`
- `resize`
- `signal`
- append-only `event-log.jsonl`
- log validation helpers

### Acceptance criteria

- every input action writes an event-log entry,
- resize events are recorded and applied,
- signals are recorded and delivered where supported,
- bracketed paste behavior is distinguishable from normal typing,
- unsupported key chords fail structurally.

### Required tests

- `type` echoes text into a fixture app,
- `paste` path is distinct in the event log,
- resize updates PTY dimensions,
- signal delivery produces expected exit behavior,
- event log sequence numbers remain strictly increasing.

### Dogfooding gate

Use a `resize-demo` fixture that renders:

- current rows/cols,
- last key received,
- last paste length,
- and signal status.

Required artifacts:

- one screenshot before resize,
- one screenshot after resize,
- one screenshot after paste,
- one replay video covering the whole interaction,
- exported event log attached to the dogfood notes.

## 7. Phase 3 — lazy renderer and semantic snapshots

### Scope

Implement the renderer adapter, `ghostty-web` harness, and `snapshot` / renderer-dependent `wait`.

### Deliverables

- renderer adapter interface
- lazy browser harness boot
- event-log replay into renderer
- `snapshot`
- `wait --text`
- `wait --regex`
- `wait --screen-stable-ms`
- `wait --cursor-row/--cursor-col`

### Acceptance criteria

- first snapshot request lazily initializes the renderer,
- renderer replay reaches the latest sequence number,
- snapshot JSON includes cursor, alt-screen, rows/cols, and visible lines,
- wait conditions operate on current visible screen state,
- renderer crash recovery works by replaying from the event log.

### Required tests

- snapshot shape test,
- wait-for-text integration test,
- wait-for-screen-stable test,
- renderer restart-and-replay recovery test,
- scrollback/viewport scoping test.

### Dogfooding gate

Use a fixture app that redraws aggressively and shows a visible state transition from `Loading` to `Ready`.

Required artifacts:

- snapshot JSON at `Loading`,
- snapshot JSON at `Ready`,
- screenshot at `Ready`,
- video proving the wait condition matched at the correct time,
- notes confirming that renderer recovery was tested by forcing a renderer restart.

## 8. Phase 4 — deterministic screenshots

### Scope

Implement screenshot capture from the reference renderer.

### Deliverables

- `screenshot`
- render-profile resolution
- bundled reference font
- artifact hashing
- screenshot manifest entries

### Acceptance criteria

- screenshot output is deterministic under pinned profiles,
- screenshots include metadata linking them to a sequence number,
- cursor visibility can be controlled,
- profile mismatches fail clearly.

### Required tests

- screenshot file existence + hash test,
- profile-specific screenshot dimension test,
- cursor-visible vs cursor-hidden screenshot test,
- missing-font failure test.

### Dogfooding gate

Use a color grid fixture and a box-drawing / wrapping fixture.

Required artifacts:

- dark-profile screenshot,
- light-profile screenshot,
- resize-before/after screenshot pair,
- video of the resize interaction,
- notes about any visible oddities such as clipping, cursor drift, or wrapping errors.

## 9. Phase 5 — recording export

### Scope

Implement asciicast export and replay-video export.

### Deliverables

- `record export --format asciicast`
- `record export --format webm`
- artifact manifest entries for recording/video
- replay timing modes

### Acceptance criteria

- asciicast export replays in a standard player,
- webm export is reviewable and synchronized enough for human inspection,
- accelerated timing mode works,
- exports can be reproduced from the same event log.

### Required tests

- asciicast schema / metadata test,
- webm file creation test,
- deterministic replay order test,
- accelerated timing smoke test.

### Dogfooding gate

Use the resize-demo or a richer navigation fixture.

Required artifacts:

- exported `.cast`,
- exported `.webm`,
- matching final screenshot,
- notes describing whether the final frame of the video matches the screenshot and snapshot.

## 10. Phase 6 — `doctor`, GC, and hardening

### Scope

Implement missing operational commands and hardening behaviors.

### Deliverables

- fully functional `doctor`
- `gc`
- manifest consistency checks
- stale-session reconciliation improvements
- temp-file atomic writes
- clearer structured errors

### Acceptance criteria

- `doctor` catches at least one intentionally induced failure in tests,
- `gc` never removes running sessions,
- partial artifact writes are not committed to the manifest,
- stale sockets are surfaced and recoverable.

### Required tests

- broken-browser `doctor` test,
- gc safety test,
- temp-artifact atomicity test,
- stale host PID handling test.

### Dogfooding gate

Required artifacts:

- screenshot of `doctor` success,
- screenshot of an induced `doctor` failure,
- short video showing `gc` preserving a running session,
- notes explaining any manual cleanup still needed.

## 11. Phase 7 — fixture suite and end-to-end dogfooding

### Scope

Build the fixture apps and final end-to-end proof bundle.

### Deliverables

Fixture apps under `test/fixtures/apps/`:

- `hello-prompt`
- `resize-demo`
- `color-grid`
- `alt-screen-demo`
- `unicode-grid`
- `scrollback-demo`
- `crash-demo`

### Acceptance criteria

- every fixture can be launched by `agent-tty create -- ...`,
- every fixture is used by at least one integration or e2e test,
- the final proof bundle contains screenshots and videos for the critical flows.

### Dogfooding gate

Execute the scenarios in `05-dogfooding-and-validation.md` and produce the full artifact bundle.

## 12. Quality gates between phases

The implementing AI agent should not move to the next phase until:

- tests added in the current phase pass,
- the dogfooding gate for the current phase is complete,
- screenshots and videos for that phase exist,
- and unresolved defects are either fixed or explicitly carried forward in notes.

## 13. Detailed fixture requirements

### 13.1 `hello-prompt`

Purpose:

- validate lifecycle,
- validate typed input,
- validate clean exit.

Behavior:

- render `Hello` header,
- echo typed input,
- exit on `q`.

### 13.2 `resize-demo`

Purpose:

- validate resize,
- validate cursor placement,
- validate redraw logic.

Behavior:

- render current rows/cols prominently,
- draw a border touching the visible edges,
- update immediately on resize.

### 13.3 `color-grid`

Purpose:

- validate colors,
- validate bright colors,
- validate background cells.

Behavior:

- render the full palette in a stable layout,
- include labels for each color cell.

### 13.4 `alt-screen-demo`

Purpose:

- validate alternate screen entry/exit,
- validate cursor placement after returning.

Behavior:

- toggle between primary and alternate screen with a keypress.

### 13.5 `unicode-grid`

Purpose:

- validate width handling,
- validate box-drawing,
- validate emoji and ambiguous-width behavior.

Behavior:

- render aligned columns with ASCII, box-drawing, CJK, and emoji rows.

### 13.6 `scrollback-demo`

Purpose:

- validate scrollback,
- validate large output replay.

Behavior:

- print many numbered rows,
- then enter a small interactive prompt.

### 13.7 `crash-demo`

Purpose:

- validate failure handling,
- validate artifact retention after abnormal exit.

Behavior:

- render a clear screen,
- crash on a specific key.

## 14. Validation strategy

### 14.1 Unit tests

Use unit tests for:

- key parsing,
- config resolution,
- manifest updates,
- protocol validation,
- error serialization.

### 14.2 Integration tests

Use integration tests for:

- real PTY sessions,
- event-log replay,
- wait conditions,
- snapshot generation,
- artifact manifest behavior.

### 14.3 End-to-end tests

Use e2e tests for:

- screenshot capture,
- replay video export,
- full fixture flows,
- and cross-platform smoke coverage.

## 15. Suggested CI matrix

### Tier 1 required

- Linux
- macOS

### Tier 2 optional / experimental initially

- Windows

The CI suite should separate:

- fast unit jobs,
- integration jobs,
- screenshot/replay jobs.

## 16. Risks and mitigations

### 16.1 Risk: Chromium-heavy test cost

Mitigation:

- keep renderer lazy,
- keep screenshot/video tests scoped,
- use fast fixture apps,
- separate heavy jobs in CI.

### 16.2 Risk: renderer output drifts over time

Mitigation:

- pin dependency versions tightly for v1,
- stamp artifact metadata with versions and hashes,
- require explicit snapshot updates in PRs.

### 16.3 Risk: Windows edge cases slow v1

Mitigation:

- keep Windows tier-2 until core Linux/macOS path is stable,
- document known ConPTY caveats,
- do not block v1 launch on perfect native Windows parity.

### 16.4 Risk: AI agent scope creep

Mitigation:

- follow this phase order strictly,
- defer native backends,
- defer mouse,
- defer MCP.

## 17. Rust rewrite path

The implementation should preserve a clean escape hatch for later Rust work.

### 17.1 Good Rust extraction candidates later

- event replay engine
- terminal diffing
- native renderer bridges
- large-log indexing

### 17.2 Poor early Rust extraction candidates

- CLI argument parsing
- config loading
- artifact manifest JSON
- browser harness orchestration

In other words: ship the product in TS first, then move hot or platform-sensitive internals later.

## 18. Final implementation checklist

The implementation should not be called complete until:

- all seven phases are complete,
- all fixture apps exist,
- the required screenshots and videos exist,
- Linux and macOS CI are green,
- Windows status is explicitly documented,
- and the proof bundle is good enough that a reviewer can validate the tool without rerunning it.
