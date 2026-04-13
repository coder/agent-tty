import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSkillsGetCommand } from '../../../src/cli/commands/skills/get.js';
import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  SkillGetResultSchema,
  getBundledSkill,
} from '../../../src/skills/index.js';
import type { SuccessEnvelope } from '../../helpers.js';

function readBundledSkill(name: string): string {
  return readFileSync(`skill-data/${name}/SKILL.md`, 'utf8');
}

function getWrittenStdout(calls: readonly unknown[][]): string {
  expect(calls).toHaveLength(1);
  const [output] = calls[0] ?? [];
  expect(typeof output).toBe('string');
  if (typeof output !== 'string') {
    throw new Error('expected stdout to be written as a string');
  }
  return output;
}

describe('skills get command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the raw SKILL.md content in human output', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);

    await runSkillsGetCommand('agent-tty', { json: false });

    const output = getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]);

    expect(output).toBe(readBundledSkill('agent-tty'));
  });

  it('emits a JSON envelope matching SkillGetResultSchema', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const skill = getBundledSkill('agent-tty');

    await runSkillsGetCommand('agent-tty', { json: true });

    const output = getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]);
    const parsed = JSON.parse(output) as SuccessEnvelope<unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('skills get');
    expect(SkillGetResultSchema.safeParse(parsed.result).success).toBe(true);
    expect(SkillGetResultSchema.parse(parsed.result)).toEqual({
      name: skill.frontmatter.name,
      source: skill.source,
      path: skill.path,
      content: skill.content,
    });
  });

  it('throws SKILL_NOT_FOUND for unknown skills', () => {
    try {
      void runSkillsGetCommand('missing-skill', { json: false });
      throw new Error('expected runSkillsGetCommand to throw');
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
