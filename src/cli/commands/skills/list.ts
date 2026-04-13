import { emitSuccess } from '../../output.js';

import { listBundledSkills } from '../../../skills/index.js';
import type { SkillListResult } from '../../../skills/index.js';

const COMMAND_NAME = 'skills list';

export function runSkillsListCommand(options: {
  json: boolean;
}): Promise<void> {
  const skills = listBundledSkills();
  const lines = skills.map((skill) => `${skill.name}  ${skill.description}`);
  const result: SkillListResult = { skills };

  emitSuccess({
    command: COMMAND_NAME,
    json: options.json,
    result,
    lines,
  });
  return Promise.resolve();
}
