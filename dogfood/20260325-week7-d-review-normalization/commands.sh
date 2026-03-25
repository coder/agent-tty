#!/usr/bin/env bash
set -euo pipefail

bundle_dir='dogfood/20260325-week7-d-review-normalization'
mkdir -p "$bundle_dir/logs" "$bundle_dir/screenshots"

npm ci --ignore-scripts

./node_modules/.bin/tsx src/tools/review-bundle.ts dogfood/20260325-week7-a-cli-parity
./node_modules/.bin/tsx src/tools/review-bundle.ts dogfood/20260325-week7-b-envelope-locks

tmp_mirror="$(mktemp -d /tmp/agent-terminal-week7-review.XXXXXX)"
for bundle in \
  dogfood/20260325-week6-a-cli-contract \
  dogfood/20260325-week6-d-review-surface \
  dogfood/20260325-week7-a-cli-parity \
  dogfood/20260325-week7-b-envelope-locks; do
  cp -R "$bundle" "$tmp_mirror/$(basename "$bundle")"
done
./node_modules/.bin/tsx src/tools/review-bundle.ts --all "$tmp_mirror"
rm -rf "$tmp_mirror"

./node_modules/.bin/tsx --eval "(async () => { const { chromium } = await import('playwright'); const { resolve } = await import('node:path'); const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] }); const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); await page.goto(new URL('file://' + resolve('dogfood/20260325-week7-a-cli-parity/index.html')).toString()); await page.waitForLoadState('networkidle'); await page.screenshot({ path: resolve('dogfood/20260325-week7-d-review-normalization/screenshots/01-week7-a-review-page.png'), fullPage: true }); await browser.close(); })().catch((error) => { console.error(error); process.exit(1); });"

git diff --name-only
./node_modules/.bin/tsx src/tools/review-bundle.ts dogfood/20260325-week7-d-review-normalization
./node_modules/.bin/tsx --eval "(async () => { const { chromium } = await import('playwright'); const { resolve } = await import('node:path'); const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] }); const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); await page.goto(new URL('file://' + resolve('dogfood/20260325-week7-d-review-normalization/index.html')).toString()); await page.waitForLoadState('networkidle'); await page.screenshot({ path: resolve('dogfood/20260325-week7-d-review-normalization/screenshots/02-week7-d-review-page.png'), fullPage: true }); await browser.close(); })().catch((error) => { console.error(error); process.exit(1); });"

git status --short
./node_modules/.bin/prettier --write dogfood/20260325-week7-d-review-normalization/
./node_modules/.bin/prettier --check dogfood/20260325-week7-d-review-normalization/
./node_modules/.bin/tsx src/tools/review-bundle.ts dogfood/20260325-week7-d-review-normalization
git diff --name-only
