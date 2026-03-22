npx tsx src/cli/main.ts create --json -- npx tsx test/fixtures/apps/alt-screen-demo/main.ts
npx tsx src/cli/main.ts wait 01KMBTV99F0QQ1VPW74QDXHB72 --text MAIN\ SCREEN\ READY --json
npx tsx src/cli/main.ts snapshot 01KMBTV99F0QQ1VPW74QDXHB72 --json
npx tsx src/cli/main.ts screenshot 01KMBTV99F0QQ1VPW74QDXHB72 --json
npx tsx src/cli/main.ts send-keys 01KMBTV99F0QQ1VPW74QDXHB72 Enter
npx tsx src/cli/main.ts wait 01KMBTV99F0QQ1VPW74QDXHB72 --text ALT\ SCREEN\ ACTIVE --json
npx tsx src/cli/main.ts snapshot 01KMBTV99F0QQ1VPW74QDXHB72 --json
npx tsx src/cli/main.ts screenshot 01KMBTV99F0QQ1VPW74QDXHB72 --json
npx tsx src/cli/main.ts send-keys 01KMBTV99F0QQ1VPW74QDXHB72 Enter
npx tsx src/cli/main.ts wait 01KMBTV99F0QQ1VPW74QDXHB72 --text BACK\ ON\ MAIN\ SCREEN --json
npx tsx src/cli/main.ts snapshot 01KMBTV99F0QQ1VPW74QDXHB72 --json
npx tsx src/cli/main.ts screenshot 01KMBTV99F0QQ1VPW74QDXHB72 --json
npx tsx src/cli/main.ts record export 01KMBTV99F0QQ1VPW74QDXHB72 --format webm --out dogfood/20260322-dogfood-alt-screen/videos/alt-screen.webm --json
npx tsx src/cli/main.ts record export 01KMBTV99F0QQ1VPW74QDXHB72 --format asciicast --out dogfood/20260322-dogfood-alt-screen/recordings/alt-screen.cast --json
npx tsx src/cli/main.ts wait 01KMBTV99F0QQ1VPW74QDXHB72 --exit --json
npx tsx src/cli/main.ts inspect 01KMBTV99F0QQ1VPW74QDXHB72 --json
