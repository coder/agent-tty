# Scenario E — unicode and width handling

## Outcome
- Scenario completed successfully on the second attempt after installing repo dependencies.
- Session `01KMBTSJ36G701X9QPENZ6M4SQ` exited with code 0.

## Review answers
- **Are box-drawing characters continuous (BOX row)?** Yes. The BOX row rendered as `| BOX    | ┌─┐│└┘├┤┬┴┼═║╔╗╚╝              |` in the structured/text snapshots and appeared continuous in the screenshot.
- **Do CJK rows stay column-aligned?** Yes. The CJK row remained bounded by the same pipe columns as the ASCII/BOX/EMOJI rows.
- **Do emoji rows visibly shift alignment?** No visible shift. The EMOJI row stayed aligned with the other rows in both the snapshot text and screenshot.
- **Are any replacement glyphs present?** No replacement glyphs were observed in the text snapshot or screenshot.
- **Do the pipe characters (`|`) align consistently across rows?** Yes. The row delimiters were consistently at columns 0, 9, and 42.

## Bugs / unexpected behavior
- Initial preflight failed before `npm ci` because `npx tsx src/cli/main.ts ...` could not resolve the `commander` dependency. See `preflight/01-create-missing-deps.txt` and `preflight/commands-missing-deps.log`.

## Artifacts
- `01-create.json`
- `02-wait-text.txt`
- `03-screenshot.json`
- `03-screenshot.png`
- `04-snapshot-structured.json`
- `05-snapshot-text.json`
- `06-record-export-asciicast.json`
- `06-session.cast`
- `07-wait-exit.txt`
- `08-inspect.json`
- `review.json`
- `command-status.json`
- `commands.log`
- `env.txt`
- `preflight/01-create-missing-deps.txt`
- `preflight/commands-missing-deps.log`
