import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';
import { writeTextFileAtomic } from '../../../src/storage/manifests.js';
import {
  assertOutputParentUnchanged,
  copyFileReplacing,
  resolveExplicitOutputPath,
  type ExplicitOutputPath,
} from '../../../src/storage/outputPath.js';

describe('explicit output paths', () => {
  let workspace = '';
  const sessionsRoot = (): string => join(workspace, 'home', 'sessions');
  const resolveOut = (out: string): Promise<ExplicitOutputPath> =>
    resolveExplicitOutputPath(out, sessionsRoot());

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

    await expect(resolveOut('exports/shot.png')).resolves.toMatchObject({
      path: join(workspace, 'exports', 'shot.png'),
    });
  });

  it('resolves a symlinked parent folder to its real path', async () => {
    await mkdir(join(workspace, 'real'));
    await symlink(join(workspace, 'real'), join(workspace, 'linked'));

    await expect(
      resolveOut(join(workspace, 'linked', 'shot.png')),
    ).resolves.toMatchObject({ path: join(workspace, 'real', 'shot.png') });
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

  it.skipIf(process.getuid?.() === 0)(
    'rejects a parent folder it can write but not search',
    async () => {
      const writeOnly = join(workspace, 'write-only');
      await mkdir(writeOnly);
      await chmod(writeOnly, 0o200);

      try {
        await expect(
          resolveOut(join(writeOnly, 'shot.png')),
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(writeOnly, 0o700);
      }
    },
  );

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
      resolveOut(join(workspace, 'home', 'sessions-evidence', 'shot.png')),
    ).resolves.toMatchObject({
      path: join(workspace, 'home', 'sessions-evidence', 'shot.png'),
    });
    await expect(
      resolveOut(join(workspace, 'home', 'shot.png')),
    ).resolves.toMatchObject({ path: join(workspace, 'home', 'shot.png') });
  });

  it('replaces an existing file and leaves no temporary file', async () => {
    const source = join(workspace, 'source.png');
    const output = join(workspace, 'output.png');
    await writeFile(source, 'new bytes');
    await writeFile(output, 'old bytes');

    await copyFileReplacing(source, await resolveOut(output));

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
        await resolveOut(join(workspace, 'out.png')),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(workspace)).toEqual([]);
  });

  it('refuses to write when the parent folder became a link into session storage', async () => {
    const artifacts = join(sessionsRoot(), 'session-01', 'artifacts');
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(workspace, 'exports'));
    const source = join(workspace, 'source.png');
    await writeFile(source, 'png bytes');
    const output = await resolveOut(join(workspace, 'exports', 'shot.png'));

    await rename(join(workspace, 'exports'), join(workspace, 'moved'));
    await symlink(artifacts, join(workspace, 'exports'));

    await expect(copyFileReplacing(source, output)).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
    });
    expect(await readdir(artifacts)).toEqual([]);
    expect(await readdir(join(workspace, 'moved'))).toEqual([]);
  });

  it('refuses to write when the parent folder was replaced by another folder', async () => {
    await mkdir(join(workspace, 'exports'));
    const source = join(workspace, 'source.png');
    await writeFile(source, 'png bytes');
    const output = await resolveOut(join(workspace, 'exports', 'shot.png'));

    await rename(join(workspace, 'exports'), join(workspace, 'moved'));
    await mkdir(join(workspace, 'exports'));

    await expect(copyFileReplacing(source, output)).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
    });
    expect(await readdir(join(workspace, 'exports'))).toEqual([]);
  });
  it('refuses to write when an ancestor became a link to the same folder', async () => {
    await mkdir(join(workspace, 'a', 'exports'), { recursive: true });
    const source = join(workspace, 'source.png');
    await writeFile(source, 'png bytes');
    const output = await resolveOut(
      join(workspace, 'a', 'exports', 'shot.png'),
    );

    await rename(join(workspace, 'a'), join(workspace, 'a-moved'));
    await symlink(join(workspace, 'a-moved'), join(workspace, 'a'));

    await expect(copyFileReplacing(source, output)).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
    });
    expect(await readdir(join(workspace, 'a-moved', 'exports'))).toEqual([]);
  });

  it('reports EXPORT_ERROR when the parent folder is gone before the rename', async () => {
    await mkdir(join(workspace, 'exports'));
    const output = await resolveOut(join(workspace, 'exports', 'shot.png'));
    await rm(join(workspace, 'exports'), { recursive: true });

    await expect(assertOutputParentUnchanged(output)).rejects.toMatchObject({
      code: ERROR_CODES.EXPORT_ERROR,
    });
  });

  it('gives a text write through the check EXPORT_ERROR when its folder goes away', async () => {
    await mkdir(join(workspace, 'exports'));
    const output = await resolveOut(join(workspace, 'exports', 'session.cast'));

    await expect(
      writeTextFileAtomic({
        path: output.path,
        pathLabel: 'record export path',
        contents: 'cast',
        writeErrorMessage: 'write failed',
        createParentFolders: false,
        beforeRename: async () => {
          await rm(join(workspace, 'exports'), { recursive: true });
          await assertOutputParentUnchanged(output);
        },
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.EXPORT_ERROR });
  });
});
