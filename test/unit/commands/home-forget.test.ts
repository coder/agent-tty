import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHomeForgetCommand } from '../../../src/cli/commands/home/forget.js';
import {
  readHomeRegistry,
  upsertHome,
} from '../../../src/storage/homeRegistry.js';
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
  let root = '';

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root.length > 0) {
      await rm(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('forgets a removed Home by its stored path after its parent became a symlink', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-forget-')));
    vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
    await mkdir(join(root, 'data', 'homeB'), { recursive: true });
    await upsertHome(join(root, 'data', 'homeB'));
    await rm(join(root, 'data'), { recursive: true });
    await mkdir(join(root, 'data2'));
    await symlink(join(root, 'data2'), join(root, 'data'));
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runHomeForgetCommand({
      json: true,
      path: join(root, 'data', 'homeB'),
    });

    const parsed = JSON.parse(
      getWrittenStdout(stdout.mock.calls as unknown[][]),
    ) as SuccessEnvelope<{ path: string; forgotten: boolean }>;
    expect(parsed.result).toEqual({
      path: join(root, 'data', 'homeB'),
      forgotten: true,
    });
    expect(await readHomeRegistry()).toEqual([]);
  });

  it('forgets a registered Home and reports it in the JSON envelope', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const forgotten: string[] = [];
    const forget = (path: string): Promise<string | null> => {
      forgotten.push(path);
      return Promise.resolve(path);
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
      { forget: () => Promise.resolve(null) },
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
          return Promise.resolve(path);
        },
      },
    );

    expect(forgotten).toHaveLength(1);
    expect(isAbsolute(forgotten[0] ?? '')).toBe(true);
  });
});
