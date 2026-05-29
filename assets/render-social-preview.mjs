// Renders assets/social-preview.html -> assets/social-preview.png (OG card, 1200x630).
// Supersamples at 2x then downscales with `sips` (macOS) so text stays crisp at
// the recommended OG size. Usage:  node assets/render-social-preview.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const W = 1200;
const H = 630;
const dir = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(dir, 'social-preview.html');
const outPath = join(dir, 'social-preview.png');
const hiResPath = join(dir, 'social-preview@2x.png');

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2, // -> 2400x1260 supersample
});
await page.goto(pathToFileURL(htmlPath).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(150);
await page.screenshot({
  path: hiResPath,
  clip: { x: 0, y: 0, width: W, height: H },
});
await browser.close();

// Downscale 2400x1260 -> 1200x630 (sips is built into macOS).
execFileSync(
  'sips',
  ['--resampleHeightWidth', String(H), String(W), hiResPath, '--out', outPath],
  {
    stdio: 'ignore',
  },
);
rmSync(hiResPath, { force: true });
console.log(`wrote ${outPath} (${W}x${H})`);
