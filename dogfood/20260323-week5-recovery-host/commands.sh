#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/coder/.local/bin:/home/coder/.local/bin:/home/coder/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/tmp/coder-script-data/bin:/home/coder/go/bin:/usr/local/nvm/versions/node/v22.19.0/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/tmp/coder.Is2u5P"
mise trust 2>/dev/null
mise install 2>/dev/null
mise run bootstrap 2>&1 | tail -5
mkdir -p dogfood/20260323-week5-recovery-host/{screenshots,videos,recordings,snapshots,logs}
export AGENT_TERMINAL_HOME="/tmp/tmp.ANY5QrINkU"
BUNDLE=dogfood/20260323-week5-recovery-host
npx tsx src/cli/main.ts create --json -- /bin/sh -c 'echo stale-host-proof; exec cat' > "dogfood/20260323-week5-recovery-host/01-create.json" 2> "dogfood/20260323-week5-recovery-host/logs/01-create.stderr.txt"
npx tsx src/cli/main.ts inspect 01KMDQ9S6XFPBFZSKPGJCGN2KX --json > "dogfood/20260323-week5-recovery-host/02-inspect-live.json" 2> "dogfood/20260323-week5-recovery-host/logs/02-inspect-live.stderr.txt"
npx tsx src/cli/main.ts list --json > "dogfood/20260323-week5-recovery-host/03-list-default.json" 2> "dogfood/20260323-week5-recovery-host/logs/03-list-default.stderr.txt"
kill -9 1047819
sleep 2
echo '{"command":"kill -9 1047819","exitCode":0}' > "dogfood/20260323-week5-recovery-host/04-kill-host.json"
npx tsx src/cli/main.ts inspect 01KMDQ9S6XFPBFZSKPGJCGN2KX --json > "dogfood/20260323-week5-recovery-host/05-inspect-post-crash.json" 2> "dogfood/20260323-week5-recovery-host/logs/05-inspect-post-crash.stderr.txt"
npx tsx src/cli/main.ts list --all --json > "dogfood/20260323-week5-recovery-host/06-list-all.json" 2> "dogfood/20260323-week5-recovery-host/logs/06-list-all.stderr.txt"
npx tsx src/cli/main.ts gc --json > "dogfood/20260323-week5-recovery-host/07-gc.json" 2> "dogfood/20260323-week5-recovery-host/logs/07-gc.stderr.txt"
npx tsx src/cli/main.ts list --all --json > "dogfood/20260323-week5-recovery-host/08-list-final.json" 2> "dogfood/20260323-week5-recovery-host/logs/08-list-final.stderr.txt"
rm -rf "/tmp/tmp.ANY5QrINkU"
npx vitest run test/integration/lifecycle.test.ts -t 'stale host recovery' > "dogfood/20260323-week5-recovery-host/logs/09-vitest-stale-host.log" 2>&1
