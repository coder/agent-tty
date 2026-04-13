import { describe, expect, it } from 'vitest';

import { parseSkillFrontmatter } from '../../../src/skills/frontmatter.js';

describe('parseSkillFrontmatter', () => {
  it('parses valid frontmatter and defaults advertise to true', () => {
    const parsed = parseSkillFrontmatter(`---
name: agent-tty
description: Terminal automation for agents
---
# Agent TTY
`);

    expect(parsed).toEqual({
      frontmatter: {
        name: 'agent-tty',
        description: 'Terminal automation for agents',
        advertise: true,
      },
      body: '# Agent TTY\n',
    });
  });

  it('parses explicit advertise values', () => {
    const parsed = parseSkillFrontmatter(`---
name: dogfood-tui
description: TUI QA workflow
advertise: false
---
Use this skill.
`);

    expect(parsed.frontmatter).toEqual({
      name: 'dogfood-tui',
      description: 'TUI QA workflow',
      advertise: false,
    });
    expect(parsed.body).toBe('Use this skill.\n');
  });

  it('rejects missing frontmatter', () => {
    expect(() => parseSkillFrontmatter('# Missing frontmatter\n')).toThrow(
      /must start with YAML frontmatter/u,
    );
  });

  it('rejects malformed frontmatter lines', () => {
    expect(() =>
      parseSkillFrontmatter(`---
name agent-tty
description: Missing separator
---
# Body
`),
    ).toThrow(/expected "key: value"/u);
  });

  it('rejects missing required fields', () => {
    expect(() =>
      parseSkillFrontmatter(`---
name: agent-tty
---
# Body
`),
    ).toThrow(/description/u);
  });

  it('rejects unknown fields in strict mode', () => {
    expect(() =>
      parseSkillFrontmatter(`---
name: agent-tty
description: Terminal automation
extra: true
---
# Body
`),
    ).toThrow(/extra/u);
  });
});
