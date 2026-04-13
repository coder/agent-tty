import process from 'node:process';

import { emitSuccess } from '../../output.js';

import { getBundledSkill } from '../../../skills/index.js';
import type { SkillGetResult } from '../../../skills/index.js';

const COMMAND_NAME = 'skills get';

export function runSkillsGetCommand(
  name: string,
  options: { json: boolean },
): Promise<void> {
  const skill = getBundledSkill(name);
  const result: SkillGetResult = {
    name: skill.frontmatter.name,
    source: skill.source,
    path: skill.path,
    content: skill.content,
  };

  if (!options.json) {
    process.stdout.write(result.content);
    return Promise.resolve();
  }

  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines: [result.content],
  });
  return Promise.resolve();
}
