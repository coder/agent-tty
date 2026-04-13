import { basename, dirname, isAbsolute, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getSkillDataRoot,
  getSkillFilePath,
  getSkillPath,
} from '../../../src/skills/paths.js';

describe('skill paths', () => {
  it('builds absolute paths under the skill-data root', () => {
    const skillDataRoot = getSkillDataRoot();
    const skillPath = getSkillPath('agent-tty');
    const skillFilePath = getSkillFilePath('agent-tty');

    expect(isAbsolute(skillDataRoot)).toBe(true);
    expect(basename(skillDataRoot)).toBe('skill-data');
    expect(skillPath).toBe(join(skillDataRoot, 'agent-tty'));
    expect(skillFilePath).toBe(join(skillPath, 'SKILL.md'));
    expect(dirname(skillPath)).toBe(skillDataRoot);
    expect(dirname(skillFilePath)).toBe(skillPath);
  });

  it('rejects invalid skill names', () => {
    expect(() => getSkillPath('')).toThrow(
      /skill name must be a non-empty string/u,
    );
    expect(() => getSkillPath('../escape')).toThrow(/path separators/u);
    expect(() => getSkillPath('nested/name')).toThrow(/path separators/u);
  });
});
