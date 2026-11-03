# Mouse

A user sends a mouse action to one terminal cell of a running program: a button press or release, a move (a drag while a button is held), a wheel step, with Shift, Alt or Ctrl held. agent-tty encodes the action in the mouse mode that the program turned on. If the program has mouse reporting off, the action succeeds and sends no bytes.

## Sub-features

- `mouse-press-release` presses and releases `left`, `middle` or `right` at a cell. A click is a press, then a release.
- `mouse-drag` sends a `move`, which is a drag while a button is held.
- `mouse-wheel` sends a wheel step with a `press` of `wheel-up`, `wheel-down`, `wheel-left` or `wheel-right`.
- `mouse-modifiers` holds `--shift`, `--alt` or `--ctrl` for one action.
- `mouse-off` reports `reported: false` and sends nothing when the program has no mouse mode on.
- `mouse-invalid` rejects a cell outside the grid and a bad action or button combination.
- `mouse-renderer` refuses a renderer other than `libghostty-vt`.
- `batch-mouse` sends the same action as a `mouse` step of `batch`.

## How to get to it (user POV)

- `agent-tty mouse <id> press|release|move --row <n> --col <n>`, with `--button <name>`, `--shift`, `--alt`, `--ctrl`, `--cell-width <px>`, `--cell-height <px>`. Rows and columns start at 0.
- A batch step `{"mouse":{"action":"press","button":"left","row":2,"col":3}}`, with optional `cellWidth`, `cellHeight` and `modifiers`.

## Driving it with att

Preconditions:

- `mkdir -p "$EVIDENCE/mouse"` has run. The recipe saves its proof there.
- The baseline preconditions in the README hold, and `att doctor --json | jq '.result.capabilities[] | select(.name=="mouse-input")'` has `status: "available"`.
- `M=$(att create --json -- node --import tsx test/fixtures/apps/mouse-report/main.ts | jq -r .result.sessionId)`, then `att wait "$M" --text MOUSE_READY --timeout 10000 --json` matches. The fixture turns on modes 1003 (any motion) and 1006 (SGR), and prints `MOUSE_HEX:<hex>` for each input that it reads.

- **Press.** Run `att mouse "$M" press --button left --row 4 --col 9 --json | tee "$EVIDENCE/mouse/press.json"`. `.result` has `reported: true`, `bytesWritten: 10` and a `seq`. `att wait "$M" --text 'MOUSE_HEX:1b5b3c303b31303b354d' --timeout 5000 --json` matches (`ESC[<0;10;5M`).
- **Drag.** Run `att mouse "$M" move --row 5 --col 10 --json | tee "$EVIDENCE/mouse/drag.json"`. With `left` still held, the wait for `MOUSE_HEX:1b5b3c33323b31313b364d` (`ESC[<32;11;6M`) matches.
- **Release.** Run `att mouse "$M" release --button left --row 5 --col 10 --json | tee "$EVIDENCE/mouse/release.json"`. The wait for `MOUSE_HEX:1b5b3c303b31313b366d` (`ESC[<0;11;6m`, lowercase `m`) matches.
- **Wheel.** Run `att mouse "$M" press --button wheel-down --row 7 --col 13 --json | tee "$EVIDENCE/mouse/wheel.json"`. The wait for `MOUSE_HEX:1b5b3c36353b31343b384d` (`ESC[<65;14;8M`) matches.
- **Modifiers.** Run `att mouse "$M" press --button left --row 8 --col 15 --shift --json | tee "$EVIDENCE/mouse/shift.json"`. The wait for `MOUSE_HEX:1b5b3c343b31363b394d` (`ESC[<4;16;9M`) matches. Release it with `att mouse "$M" release --button left --row 8 --col 15 --json`. Run `att mouse "$M" press --button left --row 9 --col 1 --alt --json | tee "$EVIDENCE/mouse/alt.json"`: the wait for `MOUSE_HEX:1b5b3c383b323b31304d` (`ESC[<8;2;10M`) matches. Release it at row 9, col 1. Run `att mouse "$M" press --button left --row 10 --col 1 --ctrl --json | tee "$EVIDENCE/mouse/ctrl.json"`: the wait for `MOUSE_HEX:1b5b3c31363b323b31314d` (`ESC[<16;2;11M`) matches. Release it at row 10, col 1.
- **Events.** `jq -c 'select(.type=="input_mouse") | .payload' "$AGENT_TTY_HOME/sessions/$M/events.jsonl"` has one record per action, with `action`, `row`, `col`, `modifiers`, `rendererBackend: "libghostty-vt"` and the written bytes in `dataBase64`. A `move` has no `button`.
- **Outside the grid.** Count the `input_mouse` events, then run `att mouse "$M" press --button left --row 24 --col 0 --json | tee "$EVIDENCE/mouse/out-of-range.json"`. Exit code 2, `.error.code` is `INVALID_INPUT`, the message ends in `outside the 80x24 terminal grid. Use row 0-23 and col 0-79.`, and the event count is unchanged.
- **Bad input.** Each of these exits 2 with `INVALID_INPUT`: `press` without `--button`, `move --button left`, `release --button wheel-up`, and the action `click`. Save each envelope to its own file, such as `"$EVIDENCE/mouse/bad-click.json"`.
- **Renderer.** Run `att --renderer ghostty-web mouse "$M" press --button left --row 1 --col 1 --json | tee "$EVIDENCE/mouse/renderer.json"`. Exit code 12, `CAPABILITY_UNAVAILABLE`.
- **Mouse off.** Start a program that turns reporting off after its first input: `OFF="process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?1000h\x1b[?1006hREADY');process.stdin.once('data',()=>process.stdout.write('\x1b[?1000lOFF'));"` and `O=$(att create --json -- node -e "$OFF" | jq -r .result.sessionId)`. Wait for `READY`. A first `att mouse "$O" press --button left --row 2 --col 3 --json` has `reported: true` and `bytesWritten: 9`. Wait for `OFF`. The same command again, with `| tee "$EVIDENCE/mouse/mouse-off.json"`, exits 0 with `reported: false` and `bytesWritten: 0`, and its `input_mouse` event has `dataBase64: ""`. Without `--json`, it prints `Mouse tracking suppressed the input, seq <n>.`
- **Batch.** On a new `$OFF` session `B`, run `att batch "$B" '[{"wait":{"text":"READY","timeout":10000}},{"mouse":{"action":"press","button":"left","row":2,"col":3}},{"wait":{"text":"OFF","timeout":5000}},{"mouse":{"action":"press","button":"left","row":2,"col":3}}]' --json | tee "$EVIDENCE/mouse/batch.json"`. Exit code 0, and all four steps are `completed`: step 1 has `reported: true`, step 3 has `reported: false`. `att batch "$M" '[{"mouse":{"action":"move","button":"left","row":1,"col":1}}]' --json | tee "$EVIDENCE/mouse/batch-invalid.json"` exits 2 with `Batch step 0 is invalid`.
- **Proof.** Save `att snapshot "$M" --format text --json` to `$EVIDENCE/mouse/screen.json`: it shows `MOUSE_READY` and one `MOUSE_HEX:` line per reported action. Copy `events.jsonl` of `M`, `O` and `B` there too.

## Gotchas

- There is no `click` action. Send a `press`, then a `release`.
- `reported: true` means the bytes reached the PTY, not that the program read them. Wait for the program's reaction after each action.
- `mouse` needs the `libghostty-vt` renderer. The default picks it when its native package loads, and falls back to `ghostty-web` when it does not. Then every `mouse` call exits 12. Check the `mouse-input` capability before you report a mouse bug.
- `reported: false` is not an error. A batch `mouse` step that sends nothing still counts as `completed`.
- Use a new cell for each action. The fixture's earlier `MOUSE_HEX:` lines stay on the screen, so a repeated action matches the old line.
