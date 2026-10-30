import { setImmediate as flushMicrotasks } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { createSerialManifestWriter } from '../../../src/host/manifestWriter.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';

const MANIFEST = '/tmp/agent-tty-home/sessions/session-01/session.json';

function makeRecord(cols: number): SessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-10-29T12:00:00.000Z',
    updatedAt: '2026-10-29T12:00:00.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
  };
}

function makeHeldWrite() {
  const firstWrite = Promise.withResolvers<undefined>();
  const write = vi
    .fn<(path: string, record: SessionRecord) => Promise<void>>()
    .mockReturnValueOnce(firstWrite.promise)
    .mockResolvedValue(undefined);
  return { write, releaseFirstWrite: () => firstWrite.resolve(undefined) };
}

describe('createSerialManifestWriter', () => {
  it('does not start a write until the previous write settles', async () => {
    const { write, releaseFirstWrite } = makeHeldWrite();
    let cols = 80;
    const writeManifest = createSerialManifestWriter(
      MANIFEST,
      () => makeRecord(cols++),
      write,
    );

    const first = writeManifest();
    const second = writeManifest();
    await flushMicrotasks();
    expect(write).toHaveBeenCalledTimes(1);

    releaseFirstWrite();
    await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('writes the state that is current when the write starts, not when it was requested', async () => {
    let current = makeRecord(80);
    const { write, releaseFirstWrite } = makeHeldWrite();
    const writeManifest = createSerialManifestWriter(
      MANIFEST,
      () => current,
      write,
    );

    const first = writeManifest();
    await flushMicrotasks();
    current = makeRecord(100);
    const second = writeManifest();
    current = makeRecord(120);
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(write.mock.calls).toEqual([
      [MANIFEST, makeRecord(80)],
      [MANIFEST, makeRecord(120)],
    ]);
  });

  it('skips a write whose state equals the state it wrote last', async () => {
    const write = vi
      .fn<(path: string, record: SessionRecord) => Promise<void>>()
      .mockResolvedValue(undefined);
    let current = makeRecord(80);
    const writeManifest = createSerialManifestWriter(
      MANIFEST,
      () => current,
      write,
    );

    await writeManifest();
    await writeManifest();
    current = makeRecord(100);
    await writeManifest();

    expect(write.mock.calls).toEqual([
      [MANIFEST, makeRecord(80)],
      [MANIFEST, makeRecord(100)],
    ]);
  });

  it('rejects only the caller whose write failed and still runs the next write', async () => {
    const failure = new Error('disk full');
    const write = vi
      .fn<(path: string, record: SessionRecord) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const writeManifest = createSerialManifestWriter(
      MANIFEST,
      () => makeRecord(80),
      write,
    );

    const first = writeManifest();
    const second = writeManifest();

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
