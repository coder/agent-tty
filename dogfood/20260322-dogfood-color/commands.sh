npx tsx src/cli/main.ts create --json -- npx tsx test/fixtures/apps/color-grid/main.ts
npx tsx src/cli/main.ts wait 01KMBTSNSRFHX2A7ZYDYVR16D9 --text COLOR\ GRID\ COMPLETE --json
npx tsx src/cli/main.ts screenshot 01KMBTSNSRFHX2A7ZYDYVR16D9 --profile reference-dark --json
npx tsx src/cli/main.ts screenshot 01KMBTSNSRFHX2A7ZYDYVR16D9 --profile reference-light --json
npx tsx src/cli/main.ts snapshot 01KMBTSNSRFHX2A7ZYDYVR16D9 --json
npx tsx src/cli/main.ts snapshot 01KMBTSNSRFHX2A7ZYDYVR16D9 --format text --json
npx tsx src/cli/main.ts record export 01KMBTSNSRFHX2A7ZYDYVR16D9 --format asciicast --out dogfood/20260322-dogfood-color/recordings/color-grid.cast --json
npx tsx src/cli/main.ts wait 01KMBTSNSRFHX2A7ZYDYVR16D9 --exit --json
npx tsx src/cli/main.ts inspect 01KMBTSNSRFHX2A7ZYDYVR16D9 --json
