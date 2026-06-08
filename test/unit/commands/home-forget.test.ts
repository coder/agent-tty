import { isAbsolute } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHomeForgetCommand } from '../../../src/cli/commands/home/forget.js';
import type { SuccessEnvelope } from '../../helpers.js';

function getWrittenStdout(calls: readonly unknown[][]): string {
  expect(calls).toHaveLength(1);
  const [output] = calls[0] ?? [];
  if (typeof output !== 'string') {
    throw new Error('expected stdout to be written as a string');
  }
  return output;
}

describe('home forget command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forgets a registered Home and reports it in the JSON envelope', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const forgotten: string[] = [];
    const forget = (path: string): Promise<boolean> => {
      forgotten.push(path);
      return Promise.resolve(true);
    };

    await runHomeForgetCommand(
      { json: true, path: '/homes/alpha' },
      { forget },
    );

    expect(forgotten).toEqual(['/homes/alpha']);
    const parsed = JSON.parse(
      getWrittenStdout(stdout.mock.calls as unknown[][]),
    ) as SuccessEnvelope<{ path: string; forgotten: boolean }>;
    expect(parsed.command).toBe('home forget');
    expect(parsed.result).toEqual({ path: '/homes/alpha', forgotten: true });
  });

  it('reports forgotten:false when the Home was not registered', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runHomeForgetCommand(
      { json: false, path: '/homes/ghost' },
      { forget: () => Promise.resolve(false) },
    );

    expect(getWrittenStdout(stdout.mock.calls as unknown[][])).toBe(
      'Home not in registry: /homes/ghost\n',
    );
  });

  it('normalizes a relative path to absolute before forgetting', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const forgotten: string[] = [];

    await runHomeForgetCommand(
      { json: true, path: 'rel/home' },
      {
        forget: (path) => {
          forgotten.push(path);
          return Promise.resolve(true);
        },
      },
    );

    expect(forgotten).toHaveLength(1);
    expect(isAbsolute(forgotten[0] ?? '')).toBe(true);
  });
});
