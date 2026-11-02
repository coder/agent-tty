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

import { ERROR_CODES } from '../../../src/protocol/errors.js';
import {
  copyFileReplacing,
  resolveExplicitOutputPath,
} from '../../../src/storage/outputPath.js';

describe('explicit output paths', () => {
  let workspace = '';
  const sessionsRoot = (): string => join(workspace, 'home', 'sessions');

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

    await expect(
      resolveExplicitOutputPath('exports/shot.png', sessionsRoot()),
    ).resolves.toBe(join(workspace, 'exports', 'shot.png'));
  });

  it('resolves a symlinked parent folder to its real path', async () => {
    await mkdir(join(workspace, 'real'));
    await symlink(join(workspace, 'real'), join(workspace, 'linked'));

    await expect(
      resolveExplicitOutputPath(
        join(workspace, 'linked', 'shot.png'),
        sessionsRoot(),
      ),
    ).resolves.toBe(join(workspace, 'real', 'shot.png'));
  });

  it('rejects a missing parent folder without creating it', async () => {
    await expect(
      resolveExplicitOutputPath(
        join(workspace, 'missing', 'shot.png'),
        sessionsRoot(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(workspace)).toEqual([]);
  });

  it('rejects a parent that is a file', async () => {
    await writeFile(join(workspace, 'file'), 'x');

    await expect(
      resolveExplicitOutputPath(
        join(workspace, 'file', 'shot.png'),
        sessionsRoot(),
      ),
    ).rejects.toThrow();
  });

  it('rejects a path inside session storage, also through a symlinked parent', async () => {
    const artifacts = join(sessionsRoot(), 'session-01', 'artifacts');
    await mkdir(artifacts, { recursive: true });
    await symlink(artifacts, join(workspace, 'into-session'));

    for (const out of [
      join(artifacts, 'shot.png'),
      join(sessionsRoot(), 'shot.png'),
      join(workspace, 'into-session', 'manifest.json'),
    ]) {
      await expect(
        resolveExplicitOutputPath(out, sessionsRoot()),
      ).rejects.toMatchObject({ code: ERROR_CODES.EXPORT_ERROR });
    }
  });

  it('accepts a path next to session storage', async () => {
    await mkdir(join(workspace, 'home', 'sessions-evidence'), {
      recursive: true,
    });

    await expect(
      resolveExplicitOutputPath(
        join(workspace, 'home', 'sessions-evidence', 'shot.png'),
        sessionsRoot(),
      ),
    ).resolves.toBe(join(workspace, 'home', 'sessions-evidence', 'shot.png'));
    await expect(
      resolveExplicitOutputPath(
        join(workspace, 'home', 'shot.png'),
        sessionsRoot(),
      ),
    ).resolves.toBe(join(workspace, 'home', 'shot.png'));
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
