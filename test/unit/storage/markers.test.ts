import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  writeCreateFailedMarker,
  writeDestroyMarker,
} from '../../../src/storage/manifests.js';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-tty-markers-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe.each([
  ['writeDestroyMarker', writeDestroyMarker, 'destroyed', 'destroy marker'],
  [
    'writeCreateFailedMarker',
    writeCreateFailedMarker,
    'create-failed',
    'create-failed marker',
  ],
])('%s', (_name, write, file, label) => {
  it('writes an empty file', async () => {
    const path = join(directory, file);

    await write(path, 'session-01');

    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('reports SESSION_NOT_FOUND when the session folder is gone', async () => {
    const path = join(directory, 'gone', file);

    await expect(write(path, 'session-01')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      details: { sessionId: 'session-01', markerPath: path },
    });
  });

  it('reports STORAGE_WRITE_ERROR when the rename fails', async () => {
    const path = join(directory, file);
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), '');

    await expect(write(path, 'session-01')).rejects.toMatchObject({
      code: 'STORAGE_WRITE_ERROR',
      message: `Failed to write the ${label} at ${path}.`,
      details: { path },
    });
  });

  it('rejects a relative path', async () => {
    await expect(write(file, 'session-01')).rejects.toThrow(`${label} path`);
  });
});
