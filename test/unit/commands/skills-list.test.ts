import { afterEach, describe, expect, it, vi } from 'vitest';

import { runSkillsListCommand } from '../../../src/cli/commands/skills/list.js';
import {
  SkillListResultSchema,
  SkillSummarySchema,
  listBundledSkills,
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

describe('skills list command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints one line per bundled skill in human output', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);
    const expectedSkills = listBundledSkills();

    await runSkillsListCommand({ json: false });

    const output = getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]);
    const expectedLines = expectedSkills.map((skill) => {
      expect(SkillSummarySchema.safeParse(skill).success).toBe(true);
      return `${skill.name}  ${skill.description}`;
    });

    expect(output).toBe(`${expectedLines.join('\n')}\n`);
    expect(output).toContain('agent-tty  ');
    expect(output).toContain('dogfood-tui  ');
  });

  it('emits a JSON envelope matching SkillListResultSchema', async () => {
    const stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockReturnValue(true);

    await runSkillsListCommand({ json: true });

    const output = getWrittenStdout(stdoutWriteSpy.mock.calls as unknown[][]);
    const parsed = JSON.parse(output) as SuccessEnvelope<unknown>;

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('skills list');
    expect(SkillListResultSchema.safeParse(parsed.result).success).toBe(true);
    expect(SkillListResultSchema.parse(parsed.result).skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'agent-tty' }),
        expect.objectContaining({ name: 'dogfood-tui' }),
      ]),
    );
  });
});
