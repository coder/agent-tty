import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertString, invariant } from '../util/assert.js';

const SKILL_DATA_DIRECTORY_NAME = 'skill-data';
const SKILL_FILENAME = 'SKILL.md';

function assertNonEmptyString(
  value: string,
  label: string,
): asserts value is string {
  assertString(value, `${label} must be a string`);
  invariant(value.length > 0, `${label} must be a non-empty string`);
}

function assertAbsolutePath(pathValue: string, label: string): void {
  assertNonEmptyString(pathValue, label);
  invariant(isAbsolute(pathValue), `${label} must be an absolute path`);
}

function assertSkillName(name: string): void {
  assertNonEmptyString(name, 'skill name');
  invariant(name !== '.', 'skill name must not be "."');
  invariant(name !== '..', 'skill name must not be ".."');
  invariant(
    !name.includes('/') && !name.includes('\\'),
    'skill name must not contain path separators',
  );
}

function resolveSkillDataRoot(skillDataRoot?: string): string {
  if (skillDataRoot === undefined) {
    const packageRoot = resolve(
      fileURLToPath(new URL('../../', import.meta.url)),
    );
    assertAbsolutePath(packageRoot, 'package root');
    return resolve(packageRoot, SKILL_DATA_DIRECTORY_NAME);
  }

  assertAbsolutePath(skillDataRoot, 'skillDataRoot');
  return skillDataRoot;
}

export function getSkillDataRoot(): string {
  return resolveSkillDataRoot();
}

export function getSkillPath(name: string, skillDataRoot?: string): string {
  assertSkillName(name);

  const resolvedSkillDataRoot = resolveSkillDataRoot(skillDataRoot);
  const skillPath = resolve(resolvedSkillDataRoot, name);

  invariant(
    dirname(skillPath) === resolvedSkillDataRoot,
    'skill directory must stay within the skill-data root',
  );

  return skillPath;
}

export function getSkillFilePath(name: string, skillDataRoot?: string): string {
  const skillPath = getSkillPath(name, skillDataRoot);
  const skillFilePath = resolve(skillPath, SKILL_FILENAME);

  invariant(
    dirname(skillFilePath) === skillPath,
    `${SKILL_FILENAME} must stay within the skill directory`,
  );

  return skillFilePath;
}
