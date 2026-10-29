import {
  access,
  link,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTemporarySessionDir } from '../../helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, link: vi.fn(actual.link) };
});

import { publishArtifactFile } from '../../../src/storage/artifactFiles.js';
import {
  artifactPath,
  ensureArtifactsDir,
} from '../../../src/storage/artifactPaths.js';

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

async function createArtifactsSessionDir(): Promise<string> {
  const sessionDirectory = await createTemporarySessionDir(
    'agent-tty-artifact-files-',
  );
  await ensureArtifactsDir(sessionDirectory);
  return sessionDirectory;
}

async function publish(sessionDirectory: string, contents: string) {
  const temporaryPath = artifactPath(sessionDirectory, '.tmp-test.txt');
  await writeFile(temporaryPath, contents);
  try {
    const published = await publishArtifactFile({
      sessionDir: sessionDirectory,
      temporaryPath,
      filename: 'artifact-5.txt',
    });
    await expect(readFile(published.path, 'utf8')).resolves.toBe(contents);
    return { filename: published.filename, created: published.created };
  } finally {
    await expect(access(temporaryPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
}

async function listArtifactFiles(sessionDirectory: string): Promise<string[]> {
  return (await readdir(join(sessionDirectory, 'artifacts'))).sort();
}

describe('publishArtifactFile', () => {
  afterEach(() => {
    vi.mocked(link).mockReset();
  });

  it('never replaces an existing file and reuses one with identical bytes', async () => {
    const sessionDirectory = await createArtifactsSessionDir();

    expect(await publish(sessionDirectory, 'a')).toEqual({
      filename: 'artifact-5.txt',
      created: true,
    });
    expect(await publish(sessionDirectory, 'a')).toEqual({
      filename: 'artifact-5.txt',
      created: false,
    });
    expect(await publish(sessionDirectory, 'b')).toEqual({
      filename: 'artifact-5-2.txt',
      created: true,
    });
    expect(await publish(sessionDirectory, 'b')).toEqual({
      filename: 'artifact-5-2.txt',
      created: false,
    });
    expect(await publish(sessionDirectory, 'c')).toEqual({
      filename: 'artifact-5-3.txt',
      created: true,
    });
    expect(await listArtifactFiles(sessionDirectory)).toEqual([
      'artifact-5-2.txt',
      'artifact-5-3.txt',
      'artifact-5.txt',
    ]);
  });

  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
    'copies without replacing when link fails with %s',
    async (code) => {
      const sessionDirectory = await createArtifactsSessionDir();
      vi.mocked(link).mockRejectedValue(errnoError(code));

      expect(await publish(sessionDirectory, 'a')).toEqual({
        filename: 'artifact-5.txt',
        created: true,
      });
      expect(await publish(sessionDirectory, 'a')).toEqual({
        filename: 'artifact-5.txt',
        created: false,
      });
      expect(await publish(sessionDirectory, 'b')).toEqual({
        filename: 'artifact-5-2.txt',
        created: true,
      });
      await expect(
        readFile(artifactPath(sessionDirectory, 'artifact-5.txt'), 'utf8'),
      ).resolves.toBe('a');
      expect(await listArtifactFiles(sessionDirectory)).toEqual([
        'artifact-5-2.txt',
        'artifact-5.txt',
      ]);
    },
  );

  it('retries the same name when the existing file disappears before the comparison', async () => {
    const sessionDirectory = await createArtifactsSessionDir();
    await publish(sessionDirectory, 'a');
    vi.mocked(link).mockImplementationOnce(async (_existingPath, newPath) => {
      await rm(newPath);
      throw errnoError('EEXIST');
    });

    expect(await publish(sessionDirectory, 'b')).toEqual({
      filename: 'artifact-5.txt',
      created: true,
    });
    expect(await listArtifactFiles(sessionDirectory)).toEqual([
      'artifact-5.txt',
    ]);
  });

  it('fails instead of retrying forever when a dangling symlink holds the name', async () => {
    const sessionDirectory = await createArtifactsSessionDir();
    await symlink(
      join(sessionDirectory, 'missing-target'),
      artifactPath(sessionDirectory, 'artifact-5.txt'),
    );

    await expect(publish(sessionDirectory, 'a')).rejects.toMatchObject({
      code: 'STORAGE_WRITE_ERROR',
    });
  });
});
