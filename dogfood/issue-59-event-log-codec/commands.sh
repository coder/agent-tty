#!/usr/bin/env bash
set -euo pipefail

HOME_DIR=/tmp/tmp.z9jvcxqfO5
SESSION_ID=01KQCM5YXV7201SPAN58AGD96S
BUNDLE_DIR=dogfood/issue-59-event-log-codec

npx tsx src/cli/main.ts --home "$HOME_DIR" create --json -- /bin/sh > "$BUNDLE_DIR/create.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" type "$SESSION_ID" "printf 'hello from codec dogfood\\n'" --json > "$BUNDLE_DIR/type-print.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" send-keys "$SESSION_ID" ENTER --json > "$BUNDLE_DIR/enter-print.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" wait "$SESSION_ID" --text "hello from codec dogfood" --timeout 10000 --json > "$BUNDLE_DIR/wait-text.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" type "$SESSION_ID" exit --json > "$BUNDLE_DIR/type-exit.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" send-keys "$SESSION_ID" ENTER --json > "$BUNDLE_DIR/enter-exit.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" wait "$SESSION_ID" --exit --timeout 10000 --json > "$BUNDLE_DIR/wait-exit.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" snapshot "$SESSION_ID" --json > "$BUNDLE_DIR/snapshot.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" record export "$SESSION_ID" --format asciicast --out "$PWD/$BUNDLE_DIR/recording.cast" --json > "$BUNDLE_DIR/record-export-asciicast.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" screenshot "$SESSION_ID" --json > "$BUNDLE_DIR/screenshot.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" record export "$SESSION_ID" --format webm --timing max-speed --out "$PWD/$BUNDLE_DIR/recording.webm" --json > "$BUNDLE_DIR/record-export-webm.json"
npx tsx src/cli/main.ts --home "$HOME_DIR" destroy "$SESSION_ID" --json > "$BUNDLE_DIR/destroy.json"
