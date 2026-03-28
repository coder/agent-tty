// Post-tsc build step: copies bundled renderer assets (fonts, license) from
// src/renderer/ghosttyWeb/assets into dist/renderer/ghosttyWeb/assets so that
// the published npm package includes them alongside the compiled JS.
//
// This is a plain .mjs file (not TypeScript in src/tools/) because it runs
// after tsc as part of `npm run build` and must not depend on the compilation
// output it is completing.
import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = resolve(projectRoot, 'src/renderer/ghosttyWeb/assets');
const destDir = resolve(projectRoot, 'dist/renderer/ghosttyWeb/assets');

async function main() {
  const sourceStats = await stat(sourceDir);
  if (!sourceStats.isDirectory()) {
    throw new Error(`renderer asset source must be a directory: ${sourceDir}`);
  }

  await mkdir(dirname(destDir), { recursive: true });
  await cp(sourceDir, destDir, { recursive: true, force: true });

  const destStats = await stat(destDir);
  if (!destStats.isDirectory()) {
    throw new Error(
      `renderer asset destination must be a directory: ${destDir}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
