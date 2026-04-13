import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  discoverBundledSkills,
  getBundledSkill,
  listBundledSkills,
} from '../../../src/skills/registry.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createSkillDataRoot(): Promise<string> {
  const skillDataRoot = await mkdtemp(join(tmpdir(), 'agent-tty-skills-'));
  temporaryDirectories.push(skillDataRoot);
  return skillDataRoot;
}

async function writeSkill(
  skillDataRoot: string,
  directoryName: string,
  content: string,
): Promise<void> {
  const skillDirectory = join(skillDataRoot, directoryName);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), content, 'utf8');
}

describe('bundled skill registry', () => {
  it('discovers bundled skills and builds summaries', async () => {
    const skillDataRoot = await createSkillDataRoot();
    await writeSkill(
      skillDataRoot,
      'beta',
      `---
name: beta
description: Second skill
---
# Beta
`,
    );
    await writeSkill(
      skillDataRoot,
      'alpha',
      `---
name: alpha
description: First skill
advertise: false
---
# Alpha
`,
    );

    const discovered = discoverBundledSkills({ skillDataRoot });
    const summaries = listBundledSkills({ skillDataRoot });
    const alphaSkill = getBundledSkill('alpha', { skillDataRoot });

    expect(discovered.map((skill) => skill.frontmatter.name)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(discovered.map((skill) => skill.source)).toEqual([
      'bundled',
      'bundled',
    ]);
    expect(alphaSkill.frontmatter).toEqual({
      name: 'alpha',
      description: 'First skill',
      advertise: false,
    });
    expect(alphaSkill.body).toBe('# Alpha\n');
    expect(alphaSkill.path).toBe(join(skillDataRoot, 'alpha', 'SKILL.md'));
    expect(summaries).toEqual([
      {
        name: 'alpha',
        description: 'First skill',
        source: 'bundled',
      },
      {
        name: 'beta',
        description: 'Second skill',
        source: 'bundled',
      },
    ]);
  });

  it('rejects duplicate bundled skill names', async () => {
    const skillDataRoot = await createSkillDataRoot();
    await writeSkill(
      skillDataRoot,
      'alpha-one',
      `---
name: alpha
description: First alpha
---
# Alpha one
`,
    );
    await writeSkill(
      skillDataRoot,
      'alpha-two',
      `---
name: alpha
description: Second alpha
---
# Alpha two
`,
    );

    expect(() => discoverBundledSkills({ skillDataRoot })).toThrow(
      /Duplicate bundled skill name "alpha"\./u,
    );
  });

  it('rejects bundled skills with empty bodies', async () => {
    const skillDataRoot = await createSkillDataRoot();
    await writeSkill(
      skillDataRoot,
      'empty-body',
      `---
name: empty-body
description: Missing content
---
`,
    );

    expect(() => discoverBundledSkills({ skillDataRoot })).toThrow(
      /body must not be empty/u,
    );
  });

  it('throws SKILL_NOT_FOUND for unknown skills', async () => {
    const skillDataRoot = await createSkillDataRoot();
    await writeSkill(
      skillDataRoot,
      'agent-tty',
      `---
name: agent-tty
description: Terminal automation
---
# Agent TTY
`,
    );

    try {
      getBundledSkill('missing-skill', { skillDataRoot });
      throw new Error('expected getBundledSkill to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CliError);
      if (!(error instanceof CliError)) {
        throw error;
      }

      expect(error.code).toBe(ERROR_CODES.SKILL_NOT_FOUND);
      expect(error.message).toBe('Skill not found.');
      expect(error.details).toEqual({ name: 'missing-skill' });
    }
  });
});
