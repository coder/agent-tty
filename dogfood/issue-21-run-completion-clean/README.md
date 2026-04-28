# Issue #21 — Run completion markers stay out of rendered artifacts

This bundle proves that `run --wait` no longer leaks the internal completion
marker into reviewer-facing artifacts (snapshot, screenshot, asciicast, WebM)
while still preserving the public CLI JSON envelope.

Generated under an isolated `AGENT_TTY_HOME` (`/tmp/agent-tty-issue21-dogfood-…`,
removed after capture). See `commands.sh` for the exact reproduction.

## What was exercised

The waited `run` command was:

```sh
printf "before-clean-marker-proof\n"; sleep 0.2; printf "after-clean-marker-proof\n"
```

Run marker returned in the JSON envelope: `__AT_MARKER_739e240b0762477e833bf3fd8b0dfd5f__`
(UUID portion: `739e240b0762477e833bf3fd8b0dfd5f`).

## Verification matrix

| Artifact                                | User output present   | `__AT_MARKER_` count | `agent-tty:run-complete:` count | Marker UUID count |
| --------------------------------------- | --------------------- | -------------------- | ------------------------------- | ----------------- |
| `03-snapshot.json` (visibleLines text)  | ✅ both lines         | 0                    | 0                               | 0                 |
| `05-recording.cast` (asciicast frames)  | ✅ both lines         | 0                    | 0                               | 0                 |
| `06-recording.webm` (binary, byte scan) | n/a (encoded video)   | 0                    | 0                               | 0                 |
| `07-events.jsonl` `output` events       | ✅ visible bytes only | 0                    | 0                               | 0                 |

Allowed and expected: the marker text appears only in the structured metadata
events that never reach renderer/export — `input_run.payload.marker` and
`run_complete.payload.marker`.

## Event-log highlight

Single waited run produced 9 events:

- 1 × `input_run` (carries marker as correlation metadata only)
- 7 × `output` (visible PTY bytes; marker-free)
- 1 × `run_complete` (new structured non-rendered event with `{ marker, inputRunSeq: 2 }`)

`run_complete` event payload:

```json
{ "marker": "__AT_MARKER_739e240b0762477e833bf3fd8b0dfd5f__", "inputRunSeq": 2 }
```

## Public envelope preserved

`02-run.json` still includes:

```json
{
  "accepted": true,
  "completed": true,
  "timedOut": false,
  "seq": 2,
  "durationMs": 208,
  "marker": "__AT_MARKER_739e240b0762477e833bf3fd8b0dfd5f__"
}
```

## Files

- `01-create.json` — `create` JSON envelope
- `02-run.json` — `run --wait` JSON envelope (still exposes `marker`, `completed`, `durationMs`, …)
- `03-snapshot.json` — semantic snapshot
- `04-screenshot.{json,png}` — rendered screenshot result + PNG (640 × 384, ghostty-web)
- `05-recording.cast` + `05-asciicast.json` — exported asciicast and result envelope
- `06-recording.webm` + `06-webm.json` — exported WebM (accelerated timing) and result envelope
- `07-events.jsonl` — canonical event log copy
- `08-destroy.json` — session teardown envelope
- `commands.sh` — exact reproduction script

## Suggested review order

1. `02-run.json` to confirm the public envelope is unchanged.
2. `07-events.jsonl` to see the new `run_complete` event and confirm `output` events are marker-free.
3. `03-snapshot.json` and `04-screenshot.png` to confirm the rendered terminal state contains user output but no marker.
4. `05-recording.cast` and `06-recording.webm` to confirm exported recordings are also marker-free.
