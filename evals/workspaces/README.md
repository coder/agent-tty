# evals/workspaces

## Overview

Workspace presets for eval cases. A preset names a workspace mode, an optional template directory, bootstrap commands, a working directory and environment variables. `registry.ts` keeps registered presets in an in-memory map. `resolver.ts` turns a preset into a `ResolvedWorkspacePlan` that is safe to report, and derives the raw runtime env separately. `builtins.ts` registers the one built-in preset, `agent-tty-smoke`. This directory does not run bootstrap commands. `evals/lib/cliHarness.ts` (`materializeEvalWorkspace`) does.

## Interface

- `[types.ts:WorkspacePresetSchema]`: strict Zod object with `id`, `mode` (`isolated` or `shared`), `description`, and optional `templateDir`, `bootstrap[]`, `cwd` and `env`. `[types.ts:WorkspacePreset]` is its inferred type.
- `[types.ts:ResolvedWorkspacePlan]`: resolved plan with `presetId`, `mode`, `description`, optional `templateDir`/`cwd`/`env`, normalized `bootstrap` steps and `bootstrapCount`.
- `[registry.ts:registerPreset]`: validates a preset with `WorkspacePresetSchema` and stores it by id.
- `[registry.ts:lookupPreset]`: returns the preset for an id and throws for an unknown id. `[registry.ts:listPresets]` returns all presets sorted by id.
- `[registry.ts:clearPresetsForTesting]`: clears the registry. Its comment marks it for unit tests only.
- `[resolver.ts:resolveWorkspacePreset]`: builds a `ResolvedWorkspacePlan` from `{ homeDir, repoRoot? }` and a preset. It resolves `templateDir` and `cwd`, defaults bootstrap `args` to `[]`, redacts env values, and sets `bootstrapCount`.
- `[resolver.ts:deriveEffectiveEnv]`: returns `{ ...preset.env, ...overrides }` with raw values for spawning.
- `[builtins.ts:registerBuiltinPresets]`: registers `[builtins.ts:AGENT_TTY_SMOKE_PRESET]` (id `agent-tty-smoke`, mode `isolated`, one bootstrap step that prints `agent-tty-smoke bootstrap ok` with `process.execPath -e`). Later calls do nothing.

## Invariants

- `[types.ts:WorkspacePresetIdSchema]` requires ids that match `/^[a-z0-9][a-z0-9-_]*$/`. `[types.ts:WorkspacePresetSchema]` and `[types.ts:WorkspaceBootstrapStepSchema]` are `.strict()` and require non-empty strings for description, paths and commands.
- `[registry.ts:registerPreset]` throws `Invalid workspace preset` on a schema failure and `is already registered` on a duplicate id.
- `[builtins.ts:registerBuiltinPresets]` uses a module-level `registered` flag so repeat calls do not hit the duplicate-id error. `clearPresetsForTesting` does not reset that flag.
- `[resolver.ts:assertAbsolutePath]` requires `ctx.homeDir`, and `ctx.repoRoot` when set, to be absolute.
- `[resolver.ts:resolveTemplateDir]` throws when `templateDir` is relative and `ctx.repoRoot` is missing, or when the resolved path is not an existing directory. A relative `cwd` resolves against `ctx.homeDir`, and its existence is not checked.
- `[resolver.ts:SENSITIVE_ENV_KEY_SUFFIX_REGEX]` marks env keys ending in `_TOKEN`, `_KEY`, `_SECRET` or `_PASSWORD` (case-insensitive). `[resolver.ts:redactEnv]` replaces their values with `[REDACTED]` in the plan.
- `[resolver.ts:deriveEffectiveEnv]` doc comment: the raw result is for runtime spawn use and must not be serialized or logged. The module doc comment states that preset env is applied first and case overrides go on top.

## Side Effects

- `[registry.ts:registerPreset]` and `[registry.ts:clearPresetsForTesting]` change the module-level `presetRegistry` map.
- `[builtins.ts:registerBuiltinPresets]` writes to the registry through `registerPreset` and sets the `registered` flag. `[builtins.ts:AGENT_TTY_SMOKE_PRESET]` reads `process.execPath` at module load.
- `[resolver.ts:resolveTemplateDir]` reads the filesystem with `statSync` from `node:fs`.
- `types.ts`: none found in code.

## Verification

- Run: `npx vitest run test/unit/evals/workspaces`
- Run: `npx vitest run --maxWorkers=1 test/integration/evals-workspace-presets.test.ts`
- Run: `npm run typecheck`
