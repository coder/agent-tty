# Mouse

A user sends a mouse action to one terminal cell of a running program: a button press or release, a move (plain motion, or a drag while a button is held), a wheel step, with Shift, Alt or Ctrl held. agent-tty encodes the action in the mouse mode that the program turned on. If the program has mouse reporting off, the action succeeds and sends no bytes.

## Sub-features

- `mouse-press-release` presses and releases `left`, `middle` or `right` at a cell. A click is a press, then a release.
- `mouse-move` sends a `move`: plain motion with no button held, or a drag while a button is held.
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
- Two helpers, so each action keeps its envelope: `act() { att mouse "$M" "${@:2}" --json | tee "$EVIDENCE/mouse/$1.json"; }` and `hex() { att wait "$M" --text "MOUSE_HEX:$1" --timeout 5000 --json; }`. `act <step> <args>` saves the envelope as `<step>.json`.

- **Plain move.** Run `act move-plain move --row 3 --col 4`. `.result` has `reported: true`, `bytesWritten: 10` and a `seq`. `hex 1b5b3c33353b353b344d` matches (`ESC[<35;5;4M`: motion with no button).
- **Press.** Run `act press-left press --button left --row 4 --col 9`. `hex 1b5b3c303b31303b354d` matches (`ESC[<0;10;5M`).
- **Drag.** Run `act drag move --row 5 --col 10`. With `left` still held, `hex 1b5b3c33323b31313b364d` matches (`ESC[<32;11;6M`).
- **Release.** Run `act release-left release --button left --row 5 --col 10`. `hex 1b5b3c303b31313b366d` matches (`ESC[<0;11;6m`, lowercase `m`).
- **Middle and right.** Run `act press-middle press --button middle --row 11 --col 1`, then `act release-middle release --button middle --row 11 --col 1`: `hex 1b5b3c313b323b31324d` and `hex 1b5b3c313b323b31326d` match. Run `act press-right press --button right --row 12 --col 1`, then `act release-right release --button right --row 12 --col 1`: `hex 1b5b3c323b323b31334d` and `hex 1b5b3c323b323b31336d` match.
- **Wheel.** Run `act wheel-down press --button wheel-down --row 7 --col 13`: `hex 1b5b3c36353b31343b384d` matches (`ESC[<65;14;8M`). Run `act wheel-up press --button wheel-up --row 13 --col 1`, `act wheel-left press --button wheel-left --row 14 --col 1` and `act wheel-right press --button wheel-right --row 15 --col 1`: `hex 1b5b3c36343b323b31344d`, `hex 1b5b3c36363b323b31354d` and `hex 1b5b3c36373b323b31364d` match (codes 64, 66, 67).
- **Modifiers.** Run `act shift press --button left --row 8 --col 15 --shift`: `hex 1b5b3c343b31363b394d` matches (`ESC[<4;16;9M`). Run `act shift-release release --button left --row 8 --col 15`: `hex 1b5b3c303b31363b396d` matches. Run `act alt press --button left --row 9 --col 1 --alt`: `hex 1b5b3c383b323b31304d` matches (`ESC[<8;2;10M`). Run `act alt-release release --button left --row 9 --col 1`: `hex 1b5b3c303b323b31306d` matches. Run `act ctrl press --button left --row 10 --col 1 --ctrl`: `hex 1b5b3c31363b323b31314d` matches (`ESC[<16;2;11M`). Run `act ctrl-release release --button left --row 10 --col 1`: `hex 1b5b3c303b323b31316d` matches.
- **Same-cell motion.** Start a program that prints nothing after its prompt: `SIL="process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?1003h\x1b[?1006hREADY');"` and `Q=$(att create --json -- node -e "$SIL" | jq -r .result.sessionId)`, then `att wait "$Q" --text READY --timeout 10000 --json`. `att mouse "$Q" move --row 2 --col 3 --json | tee "$EVIDENCE/mouse/same-cell-1.json"` has `reported: true`. Swap the renderer with `att --renderer ghostty-web snapshot "$Q" --json`. The same `move` again, with `| tee "$EVIDENCE/mouse/same-cell-2.json"`, has `reported: false` and `bytesWritten: 0`.
- **Encodings.** A program that turns on mode 1000 plus the modes in its arguments and prints each input as `HEX:<hex>`: `ENC="process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?1000h'+process.argv.slice(1).map(m=>'\x1b[?'+m+'h').join('')+'READY\r\n');process.stdin.on('data',d=>process.stdout.write('HEX:'+d.toString('hex')+'\r\n'));"`. For each mode below, run `X=$(att create --json --cols 240 -- node -e "$ENC" <modes> | jq -r .result.sessionId)` and `att wait "$X" --text READY --timeout 10000 --json`, then `att mouse "$X" press --button left --row 2 --col 222 <flags> --json | tee "$EVIDENCE/mouse/enc-<name>.json"`. `att wait "$X" --text 'HEX:<hex>' --timeout 5000 --json` matches. `<name>` `x10`, no modes: `1b5b4d20ff23`. `<name>` `utf8`, mode `1005`: `1b5b4d20c3bf23`. `<name>` `urxvt`, mode `1015`: `1b5b33323b3232333b334d`. `<name>` `sgr-pixels`, mode `1016` with the flags `--cell-width 10 --cell-height 20`: `1b5b3c303b323232303b34304d` (`ESC[<0;2220;40M`).
- **Events.** `jq -c 'select(.type=="input_mouse") | .payload' "$AGENT_TTY_HOME/sessions/$M/events.jsonl"` has one record per action, with `action`, `row`, `col`, `modifiers`, `rendererBackend: "libghostty-vt"` and the written bytes in `dataBase64`. A `move` has no `button`.
- **Outside the grid.** Count the `input_mouse` events, then run `act out-of-range press --button left --row 24 --col 0`. Exit code 2, `.error.code` is `INVALID_INPUT`, the message ends in `outside the 80x24 terminal grid. Use row 0-23 and col 0-79.`, and the event count is unchanged.
- **Bad input.** Each of these exits 2 with `INVALID_INPUT` and adds no event: `act bad-no-button press --row 1 --col 1`, `act bad-move-button move --button left --row 1 --col 1`, `act bad-wheel-release release --button wheel-up --row 1 --col 1` and `act bad-click click --button left --row 1 --col 1`.
- **Renderer.** Run `att --renderer ghostty-web mouse "$M" press --button left --row 1 --col 1 --json | tee "$EVIDENCE/mouse/renderer.json"`. Exit code 12, `CAPABILITY_UNAVAILABLE`.
- **Mouse off.** Start a program that turns reporting off after its first input: `OFF="process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?1000h\x1b[?1006hREADY');process.stdin.once('data',()=>process.stdout.write('\x1b[?1000lOFF'));"` and `O=$(att create --json -- node -e "$OFF" | jq -r .result.sessionId)`. `att wait "$O" --text READY --timeout 10000 --json` matches. `att mouse "$O" press --button left --row 2 --col 3 --json | tee "$EVIDENCE/mouse/mouse-on.json"` has `reported: true` and `bytesWritten: 9`. `att wait "$O" --text OFF --timeout 5000 --json` matches. The same command with `| tee "$EVIDENCE/mouse/mouse-off.json"` exits 0 with `reported: false` and `bytesWritten: 0`, and its `input_mouse` event has `dataBase64: ""`. Without `--json`, it prints `Mouse tracking suppressed the input, seq <n>.`
- **Batch.** On a new `$OFF` session `B`, run `att batch "$B" '[{"wait":{"text":"READY","timeout":10000}},{"mouse":{"action":"press","button":"left","row":2,"col":3}},{"wait":{"text":"OFF","timeout":5000}},{"mouse":{"action":"press","button":"left","row":2,"col":3}}]' --json | tee "$EVIDENCE/mouse/batch.json"`. Exit code 0, and all four steps are `completed`: the step with `index` 1 has `reported: true`, and the step with `index` 3 has `reported: false`. `att batch "$M" '[{"mouse":{"action":"move","button":"left","row":1,"col":1}}]' --json | tee "$EVIDENCE/mouse/batch-invalid.json"` exits 2 with `Batch step 0 is invalid`.
- **Proof.** Save `att snapshot "$M" --format text --json` to `$EVIDENCE/mouse/screen.json`: it shows `MOUSE_READY` and one `MOUSE_HEX:` line per reported action of `M`. Copy the `events.jsonl` of `M`, `O` and `B` there as `events-M.jsonl`, `events-O.jsonl` and `events-B.jsonl`.

## Gotchas

- There is no `click` action. Send a `press`, then a `release`.
- `reported: true` means the bytes reached the PTY, not that the program read them. Wait for the program's reaction after each action.
- `mouse` needs the `libghostty-vt` renderer. The default picks it when its native package loads, and falls back to `ghostty-web` when it does not. Then every `mouse` call exits 12. Check the `mouse-input` capability before you report a mouse bug.
- `reported: false` is not an error. A batch `mouse` step that sends nothing still counts as `completed`.
- Same-cell motion is suppressed only while the program prints nothing between the two moves. `mouse-report` prints a line for each input, so a repeated `move` on `M` is reported again. Use a silent program, as in the Same-cell motion step.
- Use a new cell for each action. The fixture's earlier `MOUSE_HEX:` lines stay on the screen, so a repeated action matches the old line.
