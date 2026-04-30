# Vendored Sandcastle Coder provider

This directory vendors the unreleased `@ai-hero/sandcastle/sandboxes/coder` provider so the triage-flow runner can construct Coder workspaces while continuing to depend on the published `@ai-hero/sandcastle` 0.5.6 package. The runner behavior is unchanged; this is only a build/import strategy swap until the upstream subpath is available in a release.

## Source

- Upstream file: `src/sandboxes/coder.ts`
- Upstream commit: `4c5ddb8821d7ba8287a08c4950dc8e886a0e3e3a`
- Upstream PR: <https://github.com/mattpocock/sandcastle/pull/495>

## Edit log

- Rewrote the single import from `../SandboxProvider.js` to type imports from `@ai-hero/sandcastle`, preserving compatibility with the published package's exported types.
- Mirrored the tiny published `createIsolatedSandboxProvider` 0.5.6 runtime helper locally so static imports of this vendored module do not eagerly load Sandcastle's main entry during dry-run/test paths.
- Adjusted two optional-property object literals to omit `undefined` keys so the vendored file typechecks under this repository's `exactOptionalPropertyTypes` setting.
- Added `.sandcastle/vendor/**` to Oxlint ignores because the upstream file intentionally contains style-only patterns that violate local rules such as `typescript/no-non-null-assertion`, `typescript/no-base-to-string`, and `typescript/no-unnecessary-type-assertion`.
- Ran the project formatter (`npm run format`) after import, so quote/trailing-comma/style differences from upstream are formatter-only changes.
- No behavior changes were made.

## Removal criteria

When `@ai-hero/sandcastle` releases a version that exports `./sandboxes/coder`, delete this directory and revert `.sandcastle/main.ts` to import `coder` from `@ai-hero/sandcastle/sandboxes/coder`.

## How to refresh

1. Check out the upstream Sandcastle repository at the desired commit.
2. Copy `src/sandboxes/coder.ts` into `.sandcastle/vendor/sandcastle-coder/coder.ts`.
3. Re-apply the header comment that documents the upstream source.
4. Rewrite the `../SandboxProvider.js` import to type imports from `@ai-hero/sandcastle` and re-add the local `createIsolatedSandboxProvider` mirror unless importing the package main is safe during dry-run/test module loads.
5. Re-apply the `exactOptionalPropertyTypes` object-literal adjustments if upstream has not already made equivalent changes.
6. Run `npm run format`, then run the sandcastle validation commands from the repository root.
