#!/usr/bin/env bash
set -euo pipefail

npx tsx src/tools/review-bundle.ts dogfood/20260325-week6-a-cli-contract
npx tsx src/tools/review-bundle.ts --all dogfood/
find dogfood -maxdepth 2 -name 'index.html' | sort
npx tsx --eval "(async () => { const { chromium } = await import('playwright'); const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await page.goto('file://' + process.cwd() + '/dogfood/20260325-week6-a-cli-contract/index.html'); await page.waitForLoadState('networkidle'); await page.screenshot({ path: 'dogfood/20260325-week6-d-review-surface/screenshots/01-week6-a-review-page.png', fullPage: true }); await browser.close(); })().catch((error) => { console.error(error); process.exit(1); });"
rm -rf '/tmp/agent-terminal-week6.N8X5Dz' && printf 'removed %s\n' '/tmp/agent-terminal-week6.N8X5Dz'
find dogfood -maxdepth 2 -name 'index.html' ! -path 'dogfood/20260325-week6-a-cli-contract/index.html' ! -path 'dogfood/20260325-week6-b-artifact-health/index.html' ! -path 'dogfood/20260325-week6-c-failure-taxonomy/index.html' ! -path 'dogfood/20260325-week6-d-review-surface/index.html' -print -delete
npx tsx src/tools/review-bundle.ts --all dogfood/
find dogfood/20260325-week6-* -maxdepth 1 -name 'index.html' | sort
find dogfood -maxdepth 2 -name 'index.html' ! -path 'dogfood/20260325-week6-a-cli-contract/index.html' ! -path 'dogfood/20260325-week6-b-artifact-health/index.html' ! -path 'dogfood/20260325-week6-c-failure-taxonomy/index.html' ! -path 'dogfood/20260325-week6-d-review-surface/index.html' -print -delete
npx tsx src/tools/review-bundle.ts --all dogfood/
find dogfood/20260325-week6-* -maxdepth 1 -name 'index.html' | sort
find dogfood -maxdepth 2 -name 'index.html' ! -path 'dogfood/20260325-week6-a-cli-contract/index.html' ! -path 'dogfood/20260325-week6-b-artifact-health/index.html' ! -path 'dogfood/20260325-week6-c-failure-taxonomy/index.html' ! -path 'dogfood/20260325-week6-d-review-surface/index.html' -print -delete
npx tsx src/tools/review-bundle.ts dogfood/20260325-week6-d-review-surface
