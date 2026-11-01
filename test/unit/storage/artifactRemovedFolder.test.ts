import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  afterReadFile: undefined as ((path: string) => Promise<void>) | undefined,
  afterMkdir: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const readFile = async (
    ...args: Parameters<typeof actual.readFile>
  ): Promise<string | Buffer> => {
    const contents = await actual.readFile(...args);
    if (typeof args[0] === 'string') {
      await fsHooks.afterReadFile?.(args[0]);
    }
    return contents;
  };
  const mkdir = async (
    ...args: Parameters<typeof actual.mkdir>
  ): Promise<string | undefined> => {
    const created = await actual.mkdir(...args);
    if (typeof args[0] === 'string') {
      await fsHooks.afterMkdir?.(args[0]);
    }
    return created;
  };
  return { ...actual, readFile, mkdir };
});

import type * as FsPromises from 'node:fs/promises';

import { createTestSemanticSnapshot } from '../../helpers.js';
import { createFakeBackend } from '../../helpers/fakeBackend.js';

import { captureScreenshotResult } from '../../../src/screenshot/capture.js';
import { captureSnapshotResult } from '../../../src/snapshot/capture.js';
import {
  appendArtifactWithRollback,
  createArtifactEntry,
  writeArtifactManifest,
} from '../../../src/storage/artifactManifest.js';
import {
  artifactPath,
  ensureArtifactsDir,
} from '../../../src/storage/artifactPaths.js';

let sessionDirectory: string;

beforeEach(async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-tty-artifact-removed-')),
  );
  sessionDirectory = join(home, 'session-01');
  await mkdir(sessionDirectory);
});

afterEach(async () => {
  fsHooks.afterReadFile = undefined;
  fsHooks.afterMkdir = undefined;
  await rm(join(sessionDirectory, '..'), { recursive: true, force: true });
});

function gcRemovesSessionAfter(
  hook: 'afterReadFile' | 'afterMkdir',
  path: string,
): void {
  let fired = false;
  fsHooks[hook] = async (calledPath) => {
    if (!fired && calledPath === path) {
      fired = true;
      await rm(sessionDirectory, { recursive: true, force: true });
    }
  };
}

describe('artifact writes after gc removed the session folder', () => {
  it('ensureArtifactsDir reports SESSION_NOT_FOUND and creates nothing', async () => {
    await rm(sessionDirectory, { recursive: true, force: true });

    await expect(ensureArtifactsDir(sessionDirectory)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      details: { sessionId: 'session-01' },
    });

    expect(existsSync(sessionDirectory)).toBe(false);
  });

  it('an artifact manifest append reports SESSION_NOT_FOUND and creates nothing', async () => {
    await writeArtifactManifest(sessionDirectory, {
      version: 1,
      sessionId: 'session-01',
      artifacts: [],
    });
    gcRemovesSessionAfter(
      'afterReadFile',
      artifactPath(sessionDirectory, 'manifest.json'),
    );

    await expect(
      appendArtifactWithRollback({
        sessionDir: sessionDirectory,
        entry: createArtifactEntry({
          kind: 'recording',
          filename: 'recording-4-asciicast.cast',
          sessionId: 'session-01',
          capturedAtSeq: 4,
          metadata: {},
        }),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

    expect(existsSync(sessionDirectory)).toBe(false);
  });

  it('a snapshot fails and creates nothing when the folder goes after its artifacts folder check', async () => {
    gcRemovesSessionAfter('afterMkdir', join(sessionDirectory, 'artifacts'));

    await expect(
      captureSnapshotResult({
        sessionDir: sessionDirectory,
        format: 'structured',
        snapshot: createTestSemanticSnapshot(),
        rendererBackend: 'test-backend',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toThrow();

    expect(existsSync(sessionDirectory)).toBe(false);
  });

  it('a screenshot reports SESSION_NOT_FOUND when the folder goes before the PNG write', async () => {
    gcRemovesSessionAfter('afterMkdir', join(sessionDirectory, 'artifacts'));

    await expect(
      captureScreenshotResult({
        backend: createFakeBackend(),
        sessionDir: sessionDirectory,
        profileName: 'reference-dark',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      details: { sessionId: 'session-01' },
    });

    expect(existsSync(sessionDirectory)).toBe(false);
  });

  it('a screenshot reports SESSION_NOT_FOUND when the folder goes before the publish', async () => {
    const renderer = createFakeBackend();
    const backend = {
      screenshot: async (
        ...args: Parameters<typeof renderer.screenshot>
      ): ReturnType<typeof renderer.screenshot> => {
        const result = await renderer.screenshot(...args);
        await rm(sessionDirectory, { recursive: true, force: true });
        return result;
      },
    };

    await expect(
      captureScreenshotResult({
        backend,
        sessionDir: sessionDirectory,
        profileName: 'reference-dark',
        expectedSessionId: 'session-01',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

    expect(existsSync(sessionDirectory)).toBe(false);
  });
});
