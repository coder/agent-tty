export PATH=\"/home/coder/.local/bin:/home/coder/.local/bin:/home/coder/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/tmp/coder-script-data/bin:/home/coder/go/bin:/usr/local/nvm/versions/node/v22.19.0/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/tmp/coder.Is2u5P\"
mise trust 2>/dev/null
mise install 2>/dev/null
mise run bootstrap 2>&1 | tail -5
export AGENT_TERMINAL_HOME=\"/tmp/tmp.RcD4yXCdJh\"
BUNDLE=dogfood/20260323-week5-recovery-replay
mkdir -p dogfood/20260323-week5-recovery-replay/{screenshots,videos,recordings,snapshots,logs}
npx tsx src/cli/main.ts create --json -- /bin/sh -c 'echo offline-test-data; exec cat' > \"dogfood/20260323-week5-recovery-replay/01-create.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/01-create.stderr.txt\"
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(j.result.sessionId);" \"dogfood/20260323-week5-recovery-replay/01-create.json\"
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(j.hostPid));" \"/tmp/tmp.RcD4yXCdJh/sessions/01KMDQCW908P2QQNZC9066VEGX/session.json\"
npx tsx src/cli/main.ts wait 01KMDQCW908P2QQNZC9066VEGX --text 'offline-test-data' --json > \"dogfood/20260323-week5-recovery-replay/02-wait-ready.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/02-wait-ready.stderr.txt\"
npx tsx src/cli/main.ts snapshot 01KMDQCW908P2QQNZC9066VEGX --format text --json > \"dogfood/20260323-week5-recovery-replay/03-snapshot-live.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/03-snapshot-live.stderr.txt\"
cp \"dogfood/20260323-week5-recovery-replay/03-snapshot-live.json\" \"dogfood/20260323-week5-recovery-replay/snapshots/01-snapshot-live.json\"
npx tsx src/cli/main.ts screenshot 01KMDQCW908P2QQNZC9066VEGX --json > \"dogfood/20260323-week5-recovery-replay/04-screenshot-live.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/04-screenshot-live.stderr.txt\"
kill -9 1065779
sleep 2
echo '{"command":"kill -9 1065779","exitCode":0}' > \"dogfood/20260323-week5-recovery-replay/05-kill-host.json\"
npx tsx src/cli/main.ts inspect 01KMDQCW908P2QQNZC9066VEGX --json > \"dogfood/20260323-week5-recovery-replay/06-inspect-failed.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/06-inspect-failed.stderr.txt\"
npx tsx src/cli/main.ts snapshot 01KMDQCW908P2QQNZC9066VEGX --format text --json > \"dogfood/20260323-week5-recovery-replay/07-snapshot-offline.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/07-snapshot-offline.stderr.txt\"
cp \"dogfood/20260323-week5-recovery-replay/07-snapshot-offline.json\" \"dogfood/20260323-week5-recovery-replay/snapshots/02-snapshot-offline.json\"
npx tsx src/cli/main.ts screenshot 01KMDQCW908P2QQNZC9066VEGX --json > \"dogfood/20260323-week5-recovery-replay/08-screenshot-offline.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/08-screenshot-offline.stderr.txt\"
cp \"/tmp/tmp.RcD4yXCdJh/sessions/01KMDQCW908P2QQNZC9066VEGX/events.jsonl\" \"dogfood/20260323-week5-recovery-replay/logs/events.jsonl\" 2>/dev/null || true
npx tsx src/cli/main.ts record export 01KMDQCW908P2QQNZC9066VEGX --format asciicast --out \"dogfood/20260323-week5-recovery-replay/recordings/offline-replay.cast\" --json > \"dogfood/20260323-week5-recovery-replay/09-export-asciicast.json\" 2> \"dogfood/20260323-week5-recovery-replay/logs/09-export-asciicast.stderr.txt\" || true
rm -rf \"/tmp/tmp.RcD4yXCdJh\"
npx vitest run test/unit/replay/offlineReplay.test.ts > \"dogfood/20260323-week5-recovery-replay/logs/10-vitest-offline-replay.log\" 2>&1
npx vitest run test/integration/lifecycle.test.ts -t 'failed session supports offline snapshot' > \"dogfood/20260323-week5-recovery-replay/logs/11-vitest-offline-snapshot.log\" 2>&1
