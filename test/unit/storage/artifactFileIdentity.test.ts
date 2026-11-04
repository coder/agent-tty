import type * as FsPromises from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

// Numbers above 2^53, which a plain number would round.
const WIDE = vi.hoisted(() => ({
  dev: 9_007_199_254_740_993n,
  ino: 9_007_199_254_740_995n,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    stat: (path: string, options?: { bigint?: boolean }) => {
      if (!path.startsWith('/wide/')) {
        return actual.stat(path, options);
      }
      // Two files with one device and inode number, as after a reuse.
      const mtimeNs = path === '/wide/first' ? 1_000n : 2_000n;
      return Promise.resolve(
        options?.bigint === true
          ? { ...WIDE, size: 5n, mtimeNs }
          : {
              dev: Number(WIDE.dev),
              ino: Number(WIDE.ino),
              size: 5,
              mtimeMs: Number(mtimeNs) / 1e6,
            },
      );
    },
  };
});

import { fileIdentity } from '../../../src/storage/artifactManifest.js';

describe('fileIdentity', () => {
  it('keeps device and inode numbers above 2^53 exact', async () => {
    await expect(fileIdentity('/wide/first')).resolves.toBe(
      `${String(WIDE.dev)}:${String(WIDE.ino)}:5:1000`,
    );
  });

  it('tells apart two files that share a reused inode number', async () => {
    expect(await fileIdentity('/wide/first')).not.toBe(
      await fileIdentity('/wide/second'),
    );
  });

  it('is null for a path that does not resolve', async () => {
    await expect(fileIdentity('/nonexistent/agent-tty')).resolves.toBeNull();
  });
});
