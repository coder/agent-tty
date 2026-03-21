---
author: "@mux"
date: 2026-03-19
---

# agent-terminal v1

`agent-terminal` is a CLI-first terminal automation system for AI agents and humans.

It is designed to let an agent:

- create and manage long-lived terminal sessions,
- send text, paste payloads, key chords, resize events, and signals,
- wait for TUI state changes,
- inspect semantic terminal state,
- capture deterministic screenshots,
- export replay artifacts that reviewers can inspect,
- and later swap the reference renderer for native terminal backends.

This design intentionally describes a **general product**, not a Mux-specific implementation. A future Mux integration should consume `agent-terminal` as an external CLI/runtime rather than baking Mux-specific assumptions into the design.

## Current shipped status (2026-03-21)

The repository now ships the first renderer-backed vertical slice of this design:

- long-lived session hosts,
- PTY control and append-only event logs,
- renderer-backed `snapshot` and `wait`,
- deterministic `screenshot`,
- artifact manifests,
- and proof bundles under `dogfood/`.

Replay export artifacts such as asciicast and video remain part of the design direction, but they are still future work rather than shipped functionality.

## Executive summary

The recommended v1 shape is:

1. **CLI-first** public surface: `agent-terminal ...`
2. **No MCP in v1**
3. **TypeScript/Node** implementation
4. **One session-host process per terminal session**, not a global daemon
5. **`node-pty`** for PTY/process control
6. **`ghostty-web`** as the default reference renderer
7. **Playwright** as the screenshot / replay harness
8. **Event-log-as-truth** architecture so screenshots, snapshots, and recordings can be replayed deterministically
9. **Renderer adapter interface** from day one so native renderers can be added later without redesigning the CLI

## Why this shape

This shape optimizes for the constraints discussed so far:

- it gives AI agents a fast and forgiving implementation loop,
- it keeps the public interface usable outside any single agent framework,
- it supports both semantic inspection and visual inspection,
- it avoids committing v1 to one terminal emulator forever,
- and it preserves a clean path to a later Rust rewrite of hot paths.

## Primary goals

### Product goals

- Provide a stable CLI for automating interactive terminal sessions.
- Make terminal automation **inspectable**, not just scriptable.
- Make TUI dogfooding practical for agents.
- Produce review artifacts that humans can verify.
- Keep the product useful in CI, local development, and agent loops.

### Technical goals

- Support long-lived sessions across multiple CLI invocations.
- Support Linux and macOS as tier-1 targets.
- Support Windows as a tier-2 target with explicit caveats.
- Keep rendering swappable.
- Keep the JSON contract stable and machine-friendly.
- Keep failure recovery simple and local.

## Non-goals for v1

- No MCP server in v1.
- No network service or multi-user remote control in v1.
- No requirement that sessions survive host crashes or machine reboots.
- No native-renderer parity guarantee in v1 screenshots.
- No kitty graphics / sixel / inline image parity in v1.
- No accessibility audit scope beyond basic screenshot readability and text extraction.
- No requirement that `attach` be fully equivalent to a first-class terminal emulator.

## Top-level decisions

### 1) CLI-first public interface

The public contract is the CLI and its JSON output, not an internal RPC API and not Mux tools.

This keeps `agent-terminal` reusable by:

- AI coding agents,
- shell scripts,
- CI,
- future MCP wrappers,
- and humans debugging locally.

### 2) TypeScript/Node for v1

TypeScript wins v1 because it lets one implementation language cover:

- PTY control,
- CLI development,
- schema validation,
- reference rendering,
- screenshots,
- replay capture,
- and future browser-like integrations.

The design explicitly leaves room for later Rust rewrites of:

- event-log replay,
- ANSI parsing,
- diffing,
- and native renderer adapters.

### 3) Session-host process per session

Each session gets a dedicated background host process that owns:

- the PTY,
- session metadata,
- the event log,
- optional renderer workers,
- and artifact generation.

This avoids the complexity of a single global daemon in v1 while still supporting long-lived sessions.

### 4) Event log as canonical truth

The canonical persistent record of a session is an append-only event log.

That lets v1:

- reconstruct renderer state after renderer crashes,
- regenerate screenshots deterministically,
- export asciicasts,
- render videos from replay,
- and debug failures after the fact.

### 5) Reference renderer now, native renderers later

V1 uses `ghostty-web` as a reference renderer for:

- semantic snapshots,
- deterministic screenshots,
- deterministic video replay.

The architecture reserves native backends for later:

- WezTerm-like native automation,
- Ghostty native automation,
- platform-specific compatibility runs.

## Tiered truth model

`agent-terminal` should treat terminal truth as layered rather than singular.

| Layer                  | Source of truth             | What it answers                                           |
| ---------------------- | --------------------------- | --------------------------------------------------------- |
| Execution truth        | PTY + event log             | What bytes, signals, and resize events actually occurred? |
| Reference visual truth | `ghostty-web` replay/render | What does a pinned reference renderer show?               |
| Native visual truth    | Future native adapter       | What does a real platform terminal show?                  |

This prevents v1 from pretending reference rendering is identical to native platform rendering.

## Success criteria for v1

V1 is successful when an AI agent can:

1. launch a sample TUI,
2. send keys and pasted text,
3. resize the terminal,
4. wait until the screen reaches a target state,
5. fetch a semantic snapshot of the screen,
6. capture a PNG screenshot,
7. destroy the session,
8. and leave behind an artifact bundle that a human reviewer can inspect.

Asciicast and replay-video export remain intended follow-on capabilities rather than current success criteria for the shipped slice.

## Deliverables in this design set

This design file is the entry point. Detailed supporting docs live in `design/20260319_agent-terminal-v1/`.

- [01-architecture.md](./20260319_agent-terminal-v1/01-architecture.md)
- [02-cli-contract.md](./20260319_agent-terminal-v1/02-cli-contract.md)
- [03-rendering-and-artifacts.md](./20260319_agent-terminal-v1/03-rendering-and-artifacts.md)
- [04-implementation-plan.md](./20260319_agent-terminal-v1/04-implementation-plan.md)
- [05-dogfooding-and-validation.md](./20260319_agent-terminal-v1/05-dogfooding-and-validation.md)
- [06-roadmap-and-week-1-plan.md](./20260319_agent-terminal-v1/06-roadmap-and-week-1-plan.md)
- [07-week-2-plan.md](./20260319_agent-terminal-v1/07-week-2-plan.md)

## High-level architecture

```mermaid
flowchart TD
    CLI["agent-terminal CLI"] --> SessionCtl["Session host control socket"]
    CLI --> Home["~/.agent-terminal"]

    SessionCtl --> Host["Per-session host process"]
    Host --> PTY["node-pty PTY child"]
    Host --> Log["Append-only event log"]
    Host --> Render["Renderer adapter"]
    Render --> PW["Playwright harness"]
    PW --> GW["ghostty-web reference renderer"]
    Host --> Artifacts["Snapshots / screenshots / casts / videos"]
```

## Build contract for the implementing AI agent

Any implementation based on this design should preserve these boundaries:

- The **CLI contract** is public and versioned.
- The **session host** is internal and may evolve.
- The **renderer adapter** is internal but must be interface-based from day one.
- The **event log format** is internal-but-stable enough to support replay and artifacts.
- The **artifact manifest** is public enough for automation consumers and reviewers.

The implementation should not:

- hard-code Mux concepts,
- hard-code a single future MCP transport,
- assume one renderer forever,
- or couple screenshot generation directly to live PTY ownership.

## Recommended implementation order

Implement in this order:

1. session lifecycle,
2. input + resize + signals,
3. event log,
4. semantic snapshots,
5. screenshots,
6. replay exports,
7. dogfooding fixtures,
8. native-backend extension points.

Do **not** start with native terminal automation. The reference-renderer path must exist first.

## Definition of done

The implementing AI agent should treat v1 as done only when all of the following are true:

- the CLI contract in `02-cli-contract.md` is implemented for the v1 command set,
- the artifact model in `03-rendering-and-artifacts.md` is implemented,
- the milestone acceptance criteria in `04-implementation-plan.md` are green,
- the dogfooding scenarios in `05-dogfooding-and-validation.md` have been executed,
- and the required screenshots and video proof artifacts have been produced.
