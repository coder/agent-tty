import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { emitSuccess } from '../output.js';

import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import { assertString, invariant } from '../../util/assert.js';

const COMMAND_NAME = 'skill';
const SKILL_NAME = 'agent-tty';
const SKILL_SOURCE = 'packaged-file';

export interface SkillResult {
  name: string;
  source: typeof SKILL_SOURCE;
  content: string;
}

export interface SkillDependencies {
  readFile: (path: URL, encoding: 'utf8') => Promise<string>;
  skillFileUrl: URL;
}

const DEFAULT_SKILL_DEPENDENCIES: SkillDependencies = {
  readFile: (path, encoding) => readFile(path, encoding),
  skillFileUrl: new URL('../../../skills/agent-tty/SKILL.md', import.meta.url),
};

export async function loadPackagedSkillContent(
  dependencies: Partial<SkillDependencies> = {},
): Promise<string> {
  const resolvedDependencies: SkillDependencies = {
    ...DEFAULT_SKILL_DEPENDENCIES,
    ...dependencies,
  };
  const skillPath = fileURLToPath(resolvedDependencies.skillFileUrl);
  let content: string;

  try {
    content = await resolvedDependencies.readFile(
      resolvedDependencies.skillFileUrl,
      'utf8',
    );
  } catch (error: unknown) {
    throw makeCliError(ERROR_CODES.STORAGE_READ_ERROR, {
      message: `Failed to read packaged skill at ${skillPath}.`,
      details: {
        skillPath,
      },
      cause: error,
    });
  }

  assertString(content, 'packaged skill content must be a string');
  invariant(content.length > 0, 'packaged skill content must not be empty');
  return content;
}

export async function buildSkillResult(
  dependencies: Partial<SkillDependencies> = {},
): Promise<SkillResult> {
  const content = await loadPackagedSkillContent(dependencies);

  return {
    name: SKILL_NAME,
    source: SKILL_SOURCE,
    content,
  };
}

export async function runSkillCommand(options: {
  json: boolean;
}): Promise<void> {
  const result = await buildSkillResult();

  if (!options.json) {
    process.stdout.write(result.content);
    return;
  }

  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: [result.content],
  });
}
