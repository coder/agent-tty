import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  buildSkillResult,
  loadPackagedSkillContent,
} from '../../../src/cli/commands/skill.js';

describe('skill command', () => {
  it('loads the packaged skill content', async () => {
    const expectedContent = await readFile('skills/agent-tty/SKILL.md', 'utf8');
    const content = await loadPackagedSkillContent();

    expect(content).toBe(expectedContent);
    expect(content.length).toBeGreaterThan(0);
  });

  it('builds the skill result payload', async () => {
    const result = await buildSkillResult();

    expect(result.name).toBe('agent-tty');
    expect(result.source).toBe('packaged-file');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('maps packaged skill read failures to STORAGE_READ_ERROR', async () => {
    const readFailure = Object.assign(new Error('missing skill'), {
      code: 'ENOENT',
    });

    try {
      await loadPackagedSkillContent({
        readFile: () => Promise.reject(readFailure),
      });
      throw new Error('expected loadPackagedSkillContent to reject');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CliError);
      if (!(error instanceof CliError)) {
        throw error;
      }

      const skillPath = error.details.skillPath;
      expect(error.code).toBe(ERROR_CODES.STORAGE_READ_ERROR);
      expect(error.message).toContain('Failed to read packaged skill');
      expect(error.cause).toBe(readFailure);
      expect(typeof skillPath).toBe('string');
      if (typeof skillPath !== 'string') {
        throw new Error('skillPath detail must be a string', {
          cause: error,
        });
      }
      expect(skillPath).toContain('skills/agent-tty/SKILL.md');
    }
  });
});
