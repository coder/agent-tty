export PATH="$HOME/.local/bin:$PATH" && mise trust 2>/dev/null
export PATH="$HOME/.local/bin:$PATH" && mise install 2>/dev/null
export PATH="$HOME/.local/bin:$PATH" && mise run bootstrap 2>&1 | tail -5
npx vitest run test/integration/renderer-backend.test.ts -t "recovers state after dispose and re-boot" >dogfood/20260323-week5-recovery-renderer/logs/01-vitest-renderer-recovery.log 2>&1
export AGENT_TERMINAL_HOME=$(mktemp -d)
npx tsx src/cli/main.ts create --json -- /bin/sh -c 'echo "hello from renderer"; exec cat'
npx tsx src/cli/main.ts wait 01KMDQ959NB68M2XGHAVZX1P8H --text 'hello from renderer' --json
npx tsx src/cli/main.ts screenshot 01KMDQ959NB68M2XGHAVZX1P8H --json
npx tsx src/cli/main.ts snapshot 01KMDQ959NB68M2XGHAVZX1P8H --format text --json
npx tsx src/cli/main.ts destroy 01KMDQ959NB68M2XGHAVZX1P8H --json
npx tsx src/cli/main.ts create --json -- /bin/sh -c 'echo "hello from renderer"; exec cat'
npx tsx src/cli/main.ts wait 01KMDQ9C59CHZ4KWA9B7K0DDT3 --text 'hello from renderer' --json
npx tsx src/cli/main.ts screenshot 01KMDQ9C59CHZ4KWA9B7K0DDT3 --json
npx tsx src/cli/main.ts snapshot 01KMDQ9C59CHZ4KWA9B7K0DDT3 --format text --json
npx tsx src/cli/main.ts destroy 01KMDQ9C59CHZ4KWA9B7K0DDT3 --json
rm -rf "$AGENT_TERMINAL_HOME"
