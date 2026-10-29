# src/cli/commands/skills

## Overview

This directory holds the handlers for the `skills list`, `skills get <name>` and `skills path <name>` CLI subcommands. They expose the agent skills bundled with the package. All three read the bundled skill data through `src/skills/index.ts` and print a result through `emitSuccess` or a raw stdout write.

## Interface

- `runSkillsListCommand(options)`: emits `{ skills }` from `listBundledSkills()` under the command name `skills list`. Human lines are `<name>  <description>`. [list.ts:runSkillsListCommand]
- `runSkillsGetCommand(name, options)`: builds `{ name, source, path, content }` from `getBundledSkill(name)`. Without `--json` it prints the raw `SKILL.md` content. [get.ts:runSkillsGetCommand]
- `runSkillsPathCommand(name, options)`: builds `{ name, source, path }`, where `path` is the skill directory (`dirname` of the `SKILL.md` path). [path.ts:runSkillsPathCommand]
- The result types `SkillListResult`, `SkillGetResult` and `SkillPathResult` come from `src/skills/index.ts` (defined in `src/skills/types.ts`). [src/skills/index.ts:SkillGetResult]

## Invariants

- The skill name must be a non-empty string (`assertString`, `invariant`). An unknown name throws `SKILL_NOT_FOUND`. [src/skills/registry.ts:getBundledSkill]
- `SKILL_NOT_FOUND` has no entry in the exit-code map, so the CLI exits with the fallback code 1. [src/cli/exitCodes.ts:exitCodeForError]

## Side Effects

- Every command reads the skill data root with `readdirSync` and each `SKILL.md` with `readFileSync`, through `discoverBundledSkills`. `get` and `path` read all skills, not only the requested one. [src/skills/registry.ts:discoverBundledSkills] [src/skills/registry.ts:getBundledSkill]
- `skills get` without `--json` writes the raw content to stdout with `process.stdout.write` and adds no newline. [get.ts:runSkillsGetCommand]
- `skills path` without `--json` writes the path and a newline to stdout. [path.ts:runSkillsPathCommand]
- With `--json` (and always for `skills list`), output goes to stdout through `emitSuccess`. [src/cli/output.ts:emitSuccess]

## Verification

- Run: `npx vitest run test/unit/commands/skills-list.test.ts test/unit/commands/skills-get.test.ts test/unit/commands/skills-path.test.ts`
- Run: `npm run typecheck`
