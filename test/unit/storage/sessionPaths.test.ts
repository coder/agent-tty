import crypto from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionRecord } from '../../../src/protocol/schemas.js';
import {
  manifestPath,
  eventLogPath,
  sessionDir,
  socketPath,
} from '../../../src/storage/sessionPaths.js';
import {
  readManifest,
  readManifestIfExists,
  writeManifest,
} from '../../../src/storage/manifests.js';

function createSessionRecord(): SessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('session paths', () => {
  it('builds session-specific absolute paths', () => {
    const home = '/tmp/agent-tty-home';
    const sessionId = 'session-01';
    const directory = sessionDir(home, 'session-01');
    const expectedSocketPath = `/tmp/agent-tty/${crypto.createHash('sha256').update(home).digest('hex').slice(0, 8)}/${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`;

    expect(directory).toBe('/tmp/agent-tty-home/sessions/session-01');
    expect(manifestPath(directory)).toBe(
      '/tmp/agent-tty-home/sessions/session-01/session.json',
    );
    expect(eventLogPath(directory)).toBe(
      '/tmp/agent-tty-home/sessions/session-01/events.jsonl',
    );
    expect(socketPath(directory)).toBe(expectedSocketPath);
  });

  it('asserts on invalid path helper inputs', () => {
    expect(() => sessionDir('', 'session-01')).toThrow(
      /home must be a non-empty string/u,
    );
    expect(() => sessionDir('relative/home', 'session-01')).toThrow(
      /home must be an absolute path/u,
    );
    expect(() => sessionDir('/tmp/home', '')).toThrow(
      /sessionId must be a non-empty string/u,
    );
    expect(() => sessionDir('/tmp/home', '../oops')).toThrow(
      /path separators/u,
    );
    expect(() => manifestPath('relative/path')).toThrow(
      /sessionDir must be an absolute path/u,
    );
  });
});

describe('manifest storage', () => {
  it('writes and reads manifests with validation', async () => {
    // prettier-ignore
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
    temporaryDirectories.push(home);
    const path = manifestPath(sessionDir(home, 'session-01'));
    const record = createSessionRecord();

    await writeManifest(path, record);

    const roundTripped = await readManifest(path);

    expect(roundTripped).toEqual(record);
  });

  it('returns null when a manifest does not exist', async () => {
    // prettier-ignore
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
    temporaryDirectories.push(home);
    const path = manifestPath(sessionDir(home, 'missing-session'));

    await expect(readManifestIfExists(path)).resolves.toBeNull();
  });

  it('rejects invalid manifest contents during reads', async () => {
    // prettier-ignore
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
    temporaryDirectories.push(home);
    const path = manifestPath(sessionDir(home, 'session-01'));

    await writeManifest(path, createSessionRecord());
    await writeFile(
      path,
      JSON.stringify({
        ...createSessionRecord(),
        rows: 0,
      }),
      'utf8',
    );

    await expect(readManifest(path)).rejects.toMatchObject({
      code: 'MANIFEST_VALIDATION_ERROR',
    });
  });
});
