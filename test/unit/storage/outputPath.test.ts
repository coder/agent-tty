import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  copyFileReplacing,
  resolveExplicitOutputPath,
} from '../../../src/storage/outputPath.js';

describe('explicit output paths', () => {
  let workspace = '';

  beforeEach(async () => {
    workspace = await realpath(
      await mkdtemp(join(tmpdir(), 'agent-tty-output-path-')),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workspace, { recursive: true, force: true });
  });

  it('resolves a relative path against the current working directory', async () => {
    await mkdir(join(workspace, 'exports'));
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);

    await expect(resolveExplicitOutputPath('exports/shot.png')).resolves.toBe(
      join(workspace, 'exports', 'shot.png'),
    );
  });

  it('resolves a symlinked parent folder to its real path', async () => {
    await mkdir(join(workspace, 'real'));
    await symlink(join(workspace, 'real'), join(workspace, 'linked'));

    await expect(
      resolveExplicitOutputPath(join(workspace, 'linked', 'shot.png')),
    ).resolves.toBe(join(workspace, 'real', 'shot.png'));
  });

  it('rejects a missing parent folder without creating it', async () => {
    await expect(
      resolveExplicitOutputPath(join(workspace, 'missing', 'shot.png')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(workspace)).toEqual([]);
  });

  it('rejects a parent that is a file', async () => {
    await writeFile(join(workspace, 'file'), 'x');

    await expect(
      resolveExplicitOutputPath(join(workspace, 'file', 'shot.png')),
    ).rejects.toThrow();
  });

  it('replaces an existing file and leaves no temporary file', async () => {
    const source = join(workspace, 'source.png');
    const output = join(workspace, 'output.png');
    await writeFile(source, 'new bytes');
    await writeFile(output, 'old bytes');

    await copyFileReplacing(source, output);

    expect(await readFile(output, 'utf8')).toBe('new bytes');
    expect((await readdir(workspace)).sort()).toEqual([
      'output.png',
      'source.png',
    ]);
  });

  it('leaves no temporary file when the source is missing', async () => {
    await expect(
      copyFileReplacing(
        join(workspace, 'gone.png'),
        join(workspace, 'out.png'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(workspace)).toEqual([]);
  });
});
