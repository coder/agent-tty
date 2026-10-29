# src/skills

## Overview

This module finds, parses and serves the skills bundled with the package. Each skill is a `SKILL.md` file under `<packageRoot>/skill-data/<name>/`. The package root resolves from this module's own URL, so the same path works from `src/skills/` and `dist/skills/`. The `skills list`, `skills get` and `skills path` commands in `src/cli/commands/skills/` are the callers.

## Interface

- `index.ts`: barrel. Re-exports the functions, schemas and types listed below. [index.ts]
- `parseSkillFrontmatter(markdown)`: parses a leading `---` block of flat `key: value` lines and returns `{ frontmatter, body }`. [frontmatter.ts:parseSkillFrontmatter]
- `getSkillDataRoot()`, `getSkillPath(name, skillDataRoot?)`, `getSkillFilePath(name, skillDataRoot?)`: absolute paths for `<packageRoot>/skill-data`, `<root>/<name>` and `<root>/<name>/SKILL.md`. [paths.ts:getSkillDataRoot] [paths.ts:getSkillPath] [paths.ts:getSkillFilePath]
- `discoverBundledSkills(options?)`: loads `SKILL.md` from each subdirectory of the skill-data root and sorts the skills by `frontmatter.name`. [registry.ts:discoverBundledSkills]
- `listBundledSkills(options?)`: maps the discovered skills to `{ name, description, source }` summaries. [registry.ts:listBundledSkills]
- `getBundledSkill(name, options?)`: returns one skill by `frontmatter.name`. [registry.ts:getBundledSkill]
- `BundledSkillRegistryOptions`: `{ skillDataRoot?: string }`. A custom root replaces the default skill-data root. [registry.ts:BundledSkillRegistryOptions]
- `SkillSourceSchema` (`z.literal('bundled')`), `SkillFrontmatterSchema`, `ParsedSkillDocumentSchema`, `SkillSummarySchema`, `SkillListResultSchema`, `SkillGetResultSchema`, `SkillPathResultSchema`, `BundledSkillSchema`, each with a `z.infer` type of the same name. [types.ts:SkillFrontmatterSchema] [types.ts:BundledSkillSchema] [types.ts:SkillListResultSchema]

## Invariants

- Every object schema in `types.ts` uses `.strict()`. `SkillFrontmatterSchema` requires non-empty `name` and `description` and defaults `advertise` to `true`. [types.ts:SkillFrontmatterSchema]
- `parseSkillFrontmatter` asserts with `invariant()` that the input is non-empty, starts with `---`, has a closing `---` line, has a `:` in each line with a non-empty key, has no duplicate key, and sets `advertise` only to `true` or `false`. A schema failure throws `Invalid skill frontmatter: ...`. [frontmatter.ts:parseSkillFrontmatter]
- Skill names must be non-empty, must not be `.` or `..`, and must not contain `/` or `\`. Custom roots must be absolute. `invariant()` checks that the skill directory stays inside the skill-data root and that `SKILL.md` stays inside the skill directory. [paths.ts:getSkillPath] [paths.ts:getSkillFilePath]
- `discoverBundledSkills` asserts that no two skills share a `frontmatter.name` and that each `SKILL.md` has non-empty content and a non-blank body. [registry.ts:discoverBundledSkills] [registry.ts:loadBundledSkill]
- `getBundledSkill` throws `makeCliError(ERROR_CODES.SKILL_NOT_FOUND)` (from `src/protocol/errors.ts`) when no skill matches. [registry.ts:getBundledSkill]

## Side Effects

- `discoverBundledSkills` reads the skill-data root with synchronous `fs.readdirSync` and each `SKILL.md` with `fs.readFileSync`. [registry.ts:discoverBundledSkills]
- `paths.ts` resolves paths with `fileURLToPath(import.meta.url)` and does no I/O. `frontmatter.ts`, `types.ts` and `index.ts` are pure.

## Verification

- Run: `npx vitest run test/unit/skills test/unit/commands/skills-list.test.ts test/unit/commands/skills-get.test.ts test/unit/commands/skills-path.test.ts`
- Run: `npm run typecheck`
