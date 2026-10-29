import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTemporarySessionDir } from '../../helpers.js';

import { publishArtifactFile } from '../../../src/storage/artifactFiles.js';
import {
  artifactPath,
  ensureArtifactsDir,
} from '../../../src/storage/artifactPaths.js';

describe('publishArtifactFile', () => {
  it('never replaces an existing file and reuses one with identical bytes', async () => {
    const sessionDirectory = await createTemporarySessionDir(
      'agent-tty-artifact-files-',
    );
    await ensureArtifactsDir(sessionDirectory);

    async function publish(contents: string) {
      const temporaryPath = artifactPath(sessionDirectory, '.tmp-test.txt');
      await writeFile(temporaryPath, contents);
      const published = await publishArtifactFile({
        sessionDir: sessionDirectory,
        temporaryPath,
        filename: 'artifact-5.txt',
      });
      await expect(access(temporaryPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(published.path, 'utf8')).resolves.toBe(contents);
      return { filename: published.filename, created: published.created };
    }

    expect(await publish('a')).toEqual({
      filename: 'artifact-5.txt',
      created: true,
    });
    expect(await publish('a')).toEqual({
      filename: 'artifact-5.txt',
      created: false,
    });
    expect(await publish('b')).toEqual({
      filename: 'artifact-5-2.txt',
      created: true,
    });
    expect(await publish('b')).toEqual({
      filename: 'artifact-5-2.txt',
      created: false,
    });
    expect(await publish('c')).toEqual({
      filename: 'artifact-5-3.txt',
      created: true,
    });
    expect((await readdir(join(sessionDirectory, 'artifacts'))).sort()).toEqual(
      ['artifact-5-2.txt', 'artifact-5-3.txt', 'artifact-5.txt'],
    );
  });
});
