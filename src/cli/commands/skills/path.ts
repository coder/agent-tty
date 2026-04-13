import { dirname } from 'node:path';
import process from 'node:process';

import { emitSuccess } from '../../output.js';

import { getBundledSkill } from '../../../skills/index.js';
import type { SkillPathResult } from '../../../skills/index.js';

const COMMAND_NAME = 'skills path';

export function runSkillsPathCommand(
  name: string,
  options: { json: boolean },
): Promise<void> {
  const skill = getBundledSkill(name);
  const result: SkillPathResult = {
    name: skill.frontmatter.name,
    source: skill.source,
    path: dirname(skill.path),
  };

  if (!options.json) {
    process.stdout.write(`${result.path}\n`);
    return Promise.resolve();
  }

  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: [result.path],
  });
  return Promise.resolve();
}
