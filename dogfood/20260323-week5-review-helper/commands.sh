mkdir -p dogfood/20260323-week5-review-helper/{screenshots,videos,recordings,snapshots,logs}
export PATH="$HOME/.local/bin:$PATH"
mise trust 2>/dev/null
mise install 2>/dev/null
mise run bootstrap 2>&1 | tail -5
npx tsx src/tools/review-bundle.ts dogfood/20260322-dogfood-alt-screen \
  >dogfood/20260323-week5-review-helper/logs/01-generate-single.stdout.txt \
  2>dogfood/20260323-week5-review-helper/logs/01-generate-single.stderr.txt
npx tsx --eval "(async () => { const { chromium } = await import('playwright'); const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); await page.goto('file://' + process.cwd() + '/dogfood/20260322-dogfood-alt-screen/index.html'); await page.waitForLoadState('networkidle'); await page.screenshot({ path: 'dogfood/20260323-week5-review-helper/screenshots/01-review-page-header.png' }); await page.evaluate(() => window.scrollBy(0, 800)); await new Promise((resolve) => setTimeout(resolve, 500)); await page.screenshot({ path: 'dogfood/20260323-week5-review-helper/screenshots/02-review-page-artifacts.png' }); await browser.close(); })().catch((error) => { console.error(error); process.exit(1); });" \
  >dogfood/20260323-week5-review-helper/logs/03-playwright.stdout.txt \
  2>dogfood/20260323-week5-review-helper/logs/03-playwright.stderr.txt
npx tsx src/tools/review-bundle.ts --all dogfood/ \
  >dogfood/20260323-week5-review-helper/logs/02-generate-all.stdout.txt \
  2>dogfood/20260323-week5-review-helper/logs/02-generate-all.stderr.txt
find dogfood -maxdepth 2 -name 'index.html' -delete
find dogfood -maxdepth 2 -name 'index.html'
