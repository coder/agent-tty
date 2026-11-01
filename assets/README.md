# assets

## Overview

Images and their sources for the root README and the GitHub social preview card. The only code file is `render-social-preview.mjs`, which renders `social-preview.html` to `social-preview.png`. The README hero GIF comes from `hero.tape` through the mise task `demo:hero`, which runs `vhs assets/hero.tape`.

## Interface

- `render-social-preview.mjs`: run as `node assets/render-social-preview.mjs`. It takes no arguments and exports nothing. It renders `social-preview.html` with Playwright Chromium and writes `social-preview.png` at 1200x630. No package.json script or mise task calls it. `social-preview.html` and `social-preview-spec.md` document the command. [render-social-preview.mjs:W] [render-social-preview.mjs:H]
- Non-code files (inventory):
  - hero.gif: README hero animation, the output of `hero.tape`.
  - hero.tape: VHS tape for the hero GIF. `test/unit/tools/hero-demo.test.ts` checks parts of its content.
  - social-preview.html: source of the social preview card.
  - social-preview.png: rendered social preview card.
  - social-preview-spec.md: spec for the social preview (Open Graph) image.

## Invariants

- The constants `W = 1200` and `H = 630` set the viewport, the screenshot clip and the output size. The page renders at `deviceScaleFactor: 2` and `sips` scales it down to `W`x`H`. [render-social-preview.mjs:W] [render-social-preview.mjs:H]
- The header comment says that `sips` is a macOS tool. `execFileSync` throws when `sips` is missing or fails. [render-social-preview.mjs]

## Side Effects

- Launches Playwright Chromium (`chromium.launch`) and opens `social-preview.html` through a `file://` URL. [render-social-preview.mjs:browser]
- Writes the temporary `social-preview@2x.png`, runs `sips --resampleHeightWidth` with `execFileSync` to write `social-preview.png`, then deletes the temporary file with `rmSync`. Paths resolve from `import.meta.url`, so the script does not depend on the working directory. [render-social-preview.mjs:hiResPath] [render-social-preview.mjs:outPath]

## Verification

- No automated test covers `render-social-preview.mjs`.
- Run: `node assets/render-social-preview.mjs` (macOS only, because it needs `sips`)
- Run: `npx vitest run test/unit/tools/hero-demo.test.ts` (checks parts of `hero.tape`)
