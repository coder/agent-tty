import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { assertString, invariant } from '../util/assert.js';

import { parseSkillFrontmatter } from './frontmatter.js';
import { getSkillDataRoot, getSkillFilePath } from './paths.js';
import {
  BundledSkillSchema,
  SkillSummarySchema,
  type BundledSkill,
  type SkillSummary,
} from './types.js';

export interface BundledSkillRegistryOptions {
  skillDataRoot?: string;
}

function resolveRegistrySkillDataRoot(
  options: BundledSkillRegistryOptions,
): string {
  if (options.skillDataRoot === undefined) {
    return getSkillDataRoot();
  }

  assertString(options.skillDataRoot, 'skillDataRoot must be a string');
  invariant(
    options.skillDataRoot.length > 0,
    'skillDataRoot must be a non-empty string',
  );
  invariant(
    isAbsolute(options.skillDataRoot),
    'skillDataRoot must be an absolute path',
  );
  return options.skillDataRoot;
}

function loadBundledSkill(
  skillDirectoryName: string,
  skillDataRoot: string,
): BundledSkill {
  const skillFilePath = getSkillFilePath(skillDirectoryName, skillDataRoot);
  const content = readFileSync(skillFilePath, 'utf8');

  assertString(
    content,
    `bundled skill "${skillDirectoryName}" content must be a string`,
  );
  invariant(
    content.length > 0,
    `bundled skill "${skillDirectoryName}" content must not be empty`,
  );

  const parsedDocument = parseSkillFrontmatter(content);

  invariant(
    parsedDocument.body.trim().length > 0,
    `bundled skill "${parsedDocument.frontmatter.name}" body must not be empty`,
  );

  return BundledSkillSchema.parse({
    frontmatter: parsedDocument.frontmatter,
    source: 'bundled',
    path: skillFilePath,
    content,
    body: parsedDocument.body,
  });
}

export function discoverBundledSkills(
  options: BundledSkillRegistryOptions = {},
): BundledSkill[] {
  const skillDataRoot = resolveRegistrySkillDataRoot(options);
  const discoveredSkills: BundledSkill[] = [];
  const seenNames = new Set<string>();
  const skillDirectoryNames = readdirSync(skillDataRoot, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const skillDirectoryName of skillDirectoryNames) {
    const skill = loadBundledSkill(skillDirectoryName, skillDataRoot);

    invariant(
      !seenNames.has(skill.frontmatter.name),
      `Duplicate bundled skill name "${skill.frontmatter.name}".`,
    );
    seenNames.add(skill.frontmatter.name);
    discoveredSkills.push(skill);
  }

  return discoveredSkills.sort((left, right) =>
    left.frontmatter.name.localeCompare(right.frontmatter.name),
  );
}

export function listBundledSkills(
  options: BundledSkillRegistryOptions = {},
): SkillSummary[] {
  return discoverBundledSkills(options).map((skill) =>
    SkillSummarySchema.parse({
      name: skill.frontmatter.name,
      description: skill.frontmatter.description,
      source: skill.source,
    }),
  );
}

export function getBundledSkill(
  name: string,
  options: BundledSkillRegistryOptions = {},
): BundledSkill {
  assertString(name, 'skill name must be a string');
  invariant(name.length > 0, 'skill name must be a non-empty string');

  const skill = discoverBundledSkills(options).find(
    (entry) => entry.frontmatter.name === name,
  );

  if (skill === undefined) {
    throw makeCliError(ERROR_CODES.SKILL_NOT_FOUND, {
      details: { name },
    });
  }

  return skill;
}
