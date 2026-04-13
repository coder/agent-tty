import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSkillsPathCommand } from '../../../src/cli/commands/skills/path.js';
import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  SkillPathResultSchema,
  getBundledSkill,
  getSkillPath,
} from '../../../src/skills/index.js';
import type { SuccessEnvelope } from '../../helpers.js';

function getWrittenStdout(calls: readonly unknown[][]): string {
  expect(calls).toHaveLength(1);
  const [output] = calls[0] ?? [];
  expect(typeof output).toBe('string');
  if (typeof output !== 'string') {
    throw new Error('expected stdout to be written as a string');
  }
  return output;
}

describe('skills path command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the absolute skill directory path in human output', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const expectedPath = getSkillPath('agent-tty');

    await runSkillsPathCommand('agent-tty', { json: false });

    const output = getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]);

    expect(output).toBe(`${expectedPath}\n`);
    expect(output).toContain('skill-data/agent-tty');
  });

  it('emits a JSON envelope matching SkillPathResultSchema', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const skill = getBundledSkill('agent-tty');
    const expectedPath = getSkillPath('agent-tty');

    await runSkillsPathCommand('agent-tty', { json: true });

    const output = getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]);
    const parsed = JSON.parse(output) as SuccessEnvelope<unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('skills path');
    expect(SkillPathResultSchema.safeParse(parsed.result).success).toBe(true);
    expect(SkillPathResultSchema.parse(parsed.result)).toEqual({
      name: skill.frontmatter.name,
      source: skill.source,
      path: expectedPath,
    });
  });

  it('throws SKILL_NOT_FOUND for unknown skills', () => {
    try {
      void runSkillsPathCommand('missing-skill', { json: false });
      throw new Error('expected runSkillsPathCommand to throw');
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
