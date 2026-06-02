import { describe, expect, it } from 'vitest';

import type { EventRecord } from '../../../src/protocol/schemas.js';
import type { SnapshotOptions } from '../../../src/renderer/backend.js';
import type {
  ReplayInput,
  ReplayState,
  SemanticSnapshot,
} from '../../../src/renderer/types.js';
import type {
  SessionEventBatch,
  SessionEventSource,
} from '../../../src/dashboard/eventSource.js';
import {
  LiveViewFollower,
  type FollowRendererBackend,
} from '../../../src/dashboard/liveViewFollower.js';

function outputEvent(seq: number): EventRecord {
  return {
    seq,
    ts: '2026-06-02T12:00:00.000Z',
    type: 'output',
    payload: { data: `o${seq}` },
  };
}

function exitEvent(
  seq: number,
  exitCode: number | null,
  exitSignal: string | null = null,
): EventRecord {
  return {
    seq,
    ts: '2026-06-02T12:00:00.000Z',
    type: 'exit',
    payload: { exitCode, exitSignal },
  };
}

/** A SessionEventSource that yields pre-programmed batches, then idles active. */
class FakeSource implements SessionEventSource {
  private readonly queue: SessionEventBatch[];

  constructor(batches: SessionEventBatch[]) {
    this.queue = [...batches];
  }

  poll(): Promise<SessionEventBatch> {
    const next = this.queue.shift();
    return Promise.resolve(next ?? { records: [], state: 'active' });
  }
}

interface ReplayCall {
  targetSeq: number;
  eventCount: number;
  sessionId: string;
  initialCols: number;
  initialRows: number;
}

/** A renderer backend that records calls and snapshots the latest target seq. */
class FakeBackend implements FollowRendererBackend {
  bootCount = 0;
  readonly replayCalls: ReplayCall[] = [];
  readonly snapshotOptions: (SnapshotOptions | undefined)[] = [];
  disposed = false;
  private lastSeq = 0;

  boot(): Promise<void> {
    this.bootCount += 1;
    return Promise.resolve();
  }

  replayTo(input: ReplayInput): Promise<ReplayState> {
    this.replayCalls.push({
      targetSeq: input.targetSeq,
      eventCount: input.events.length,
      sessionId: input.sessionId,
      initialCols: input.initialCols,
      initialRows: input.initialRows,
    });
    this.lastSeq = input.targetSeq;
    return Promise.resolve({
      lastSeq: input.targetSeq,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
    });
  }

  snapshot(options?: SnapshotOptions): Promise<SemanticSnapshot> {
    this.snapshotOptions.push(options);
    return Promise.resolve({
      sessionId: 'session',
      capturedAtSeq: this.lastSeq,
      cols: 80,
      rows: 24,
      cursorRow: 0,
      cursorCol: 0,
      isAltScreen: false,
      visibleLines: [{ row: 0, text: `seq ${this.lastSeq}` }],
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

function makeFollower(
  source: SessionEventSource,
  backend: FollowRendererBackend,
): LiveViewFollower {
  return new LiveViewFollower({
    source,
    backend,
    sessionId: 'session',
    initialCols: 80,
    initialRows: 24,
  });
}

describe('LiveViewFollower', () => {
  it('boots the backend and reconstructs the latest screen from ingested events', async () => {
    const source = new FakeSource([
      { records: [outputEvent(0), outputEvent(1)], state: 'active' },
    ]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    const rendered = await follower.render();

    expect(rendered).toBe(true);
    expect(backend.bootCount).toBe(1);
    expect(backend.replayCalls).toEqual([
      {
        targetSeq: 1,
        eventCount: 2,
        sessionId: 'session',
        initialCols: 80,
        initialRows: 24,
      },
    ]);
    expect(backend.snapshotOptions).toEqual([{ includeCells: true }]);
    expect(follower.frame.status).toBe('following');
    expect(follower.frame.snapshot?.capturedAtSeq).toBe(1);
  });

  it('coalesces a backlog ingested over several polls into a single frame', async () => {
    const source = new FakeSource([
      {
        records: [outputEvent(0), outputEvent(1), outputEvent(2)],
        state: 'active',
      },
      {
        records: [outputEvent(3), outputEvent(4), outputEvent(5)],
        state: 'active',
      },
    ]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    await follower.ingest();
    const rendered = await follower.render();

    expect(rendered).toBe(true);
    expect(backend.replayCalls).toHaveLength(1);
    expect(backend.replayCalls[0]).toMatchObject({
      targetSeq: 5,
      eventCount: 6,
    });
    expect(backend.snapshotOptions).toHaveLength(1);
    expect(follower.frame.snapshot?.capturedAtSeq).toBe(5);
  });

  it('passes only newly-ingested events to the backend after the first render', async () => {
    const source = new FakeSource([
      {
        records: [outputEvent(0), outputEvent(1), outputEvent(2)],
        state: 'active',
      },
      {
        records: [outputEvent(3), outputEvent(4), outputEvent(5)],
        state: 'active',
      },
    ]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    expect(await follower.render()).toBe(true);
    await follower.ingest();
    expect(await follower.render()).toBe(true);

    // The stateful backend already holds seq 0-2, so the second replay carries
    // only the new delta (seq 3-5), not the whole accumulated history.
    expect(backend.replayCalls).toEqual([
      expect.objectContaining({ targetSeq: 2, eventCount: 3 }),
      expect.objectContaining({ targetSeq: 5, eventCount: 3 }),
    ]);
  });

  it('does not re-render when no new events have arrived', async () => {
    const source = new FakeSource([
      { records: [outputEvent(0)], state: 'active' },
    ]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    expect(await follower.render()).toBe(true);

    await follower.ingest(); // idle: active, no records
    expect(await follower.render()).toBe(false);
    expect(backend.replayCalls).toHaveLength(1);
  });

  it('freezes the final screen and reports the exit code when the Session exits', async () => {
    const source = new FakeSource([
      { records: [outputEvent(0), exitEvent(1, 0)], state: 'active' },
    ]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    await follower.render();

    expect(follower.frame.status).toBe('exited');
    expect(follower.frame.exit).toEqual({ exitCode: 0, exitSignal: null });
    expect(follower.frame.snapshot?.capturedAtSeq).toBe(1);

    // Subsequent idle polls keep the screen pinned and do not re-render.
    await follower.ingest();
    expect(await follower.render()).toBe(false);
    expect(follower.frame.status).toBe('exited');
    expect(backend.replayCalls).toHaveLength(1);
  });

  it('surfaces the collected state and freezes the last screen when the log is removed', async () => {
    const source = new FakeSource([
      { records: [outputEvent(0)], state: 'active' },
      { records: [], state: 'collected' },
    ]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    await follower.render();
    const frozen = follower.frame.snapshot;

    await follower.ingest(); // collected
    expect(follower.frame.status).toBe('collected');
    expect(follower.frame.snapshot).toBe(frozen);
    expect(await follower.render()).toBe(false);
  });

  it('reports pending before the Event Log produces any entry', async () => {
    const source = new FakeSource([{ records: [], state: 'pending' }]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    expect(await follower.render()).toBe(false);
    expect(follower.frame.status).toBe('pending');
    expect(follower.frame.snapshot).toBeNull();
    expect(backend.bootCount).toBe(0);
  });

  it('reports collected even after an observed exit once the log is removed', async () => {
    const source = new FakeSource([
      { records: [outputEvent(0), exitEvent(1, 0)], state: 'active' },
      { records: [], state: 'collected' },
    ]);
    const backend = new FakeBackend();
    const follower = makeFollower(source, backend);

    await follower.ingest();
    await follower.render();
    expect(follower.frame.status).toBe('exited');

    await follower.ingest();
    expect(follower.frame.status).toBe('collected');
  });
});
