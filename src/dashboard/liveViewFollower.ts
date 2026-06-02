import type { EventRecord } from '../protocol/schemas.js';
import type { SnapshotOptions } from '../renderer/backend.js';
import type {
  ReplayInput,
  ReplayState,
  SemanticSnapshot,
} from '../renderer/types.js';
import type { SessionEventSource } from './eventSource.js';

/**
 * The subset of a renderer backend that **Event Log Follow** drives. The real
 * `libghostty-vt` backend satisfies this; tests inject a fake.
 */
export interface FollowRendererBackend {
  boot(): Promise<void>;
  replayTo(input: ReplayInput): Promise<ReplayState>;
  snapshot(options?: SnapshotOptions): Promise<SemanticSnapshot>;
  dispose(): Promise<void>;
}

/**
 * The lifecycle of a followed **Live View**:
 * - `pending`: no screen yet (Event Log not produced its first entry).
 * - `following`: actively reconstructing the live screen.
 * - `exited`: the **Session** process exited; the final screen is frozen.
 * - `collected`: the **Event Log** was removed; the frozen screen is the last
 *   thing seen and the **Session** drops out on the next list refresh.
 */
export type LiveViewStatus = 'pending' | 'following' | 'exited' | 'collected';

export interface LiveViewExit {
  exitCode: number | null;
  exitSignal: string | null;
}

export interface LiveViewFrame {
  status: LiveViewStatus;
  snapshot: SemanticSnapshot | null;
  exit?: LiveViewExit;
}

export interface LiveViewFollowerOptions {
  source: SessionEventSource;
  backend: FollowRendererBackend;
  sessionId: string;
  initialCols: number;
  initialRows: number;
}

export class LiveViewFollower {
  private readonly events: EventRecord[] = [];
  private pendingSeq = -1;
  private renderedSeq = -1;
  private booted = false;
  private collected = false;
  private exit: LiveViewExit | null = null;
  private lastSnapshot: SemanticSnapshot | null = null;

  constructor(private readonly options: LiveViewFollowerOptions) {}

  /** Pull one batch from the source and accumulate it (no rendering). */
  async ingest(): Promise<void> {
    const batch = await this.options.source.poll();

    if (batch.state === 'collected') {
      // The Event Log is gone; freeze on the last screen we reconstructed.
      this.collected = true;
      return;
    }

    for (const record of batch.records) {
      this.events.push(record);
      if (record.seq > this.pendingSeq) {
        this.pendingSeq = record.seq;
      }
      if (record.type === 'exit') {
        this.exit = {
          exitCode: record.payload.exitCode,
          exitSignal: record.payload.exitSignal,
        };
      }
    }
  }

  /**
   * Advance the screen to the latest ingested sequence in a single replay
   * (coalescing any backlog into one frame) and snapshot it. Returns whether a
   * new frame was produced. A frozen (collected) follower never re-renders.
   */
  async render(): Promise<boolean> {
    if (this.collected) {
      return false;
    }
    if (this.pendingSeq <= this.renderedSeq || this.events.length === 0) {
      return false;
    }

    if (!this.booted) {
      await this.options.backend.boot();
      this.booted = true;
    }

    await this.options.backend.replayTo({
      sessionId: this.options.sessionId,
      initialCols: this.options.initialCols,
      initialRows: this.options.initialRows,
      events: this.events,
      targetSeq: this.pendingSeq,
    });
    this.lastSnapshot = await this.options.backend.snapshot({
      includeCells: true,
    });
    this.renderedSeq = this.pendingSeq;
    // The backend is stateful (it tracks lastAppliedSeq and rejects rewinds), so
    // every accumulated event up to pendingSeq is now applied and can be
    // dropped. The next render passes only freshly-ingested events, keeping
    // memory and per-frame replay work bounded over a long session.
    this.events.length = 0;
    return true;
  }

  get frame(): LiveViewFrame {
    return {
      status: this.status(),
      snapshot: this.lastSnapshot,
      ...(this.exit === null ? {} : { exit: this.exit }),
    };
  }

  private status(): LiveViewStatus {
    if (this.collected) {
      return 'collected';
    }
    if (this.exit !== null) {
      return 'exited';
    }
    return this.lastSnapshot === null ? 'pending' : 'following';
  }

  async dispose(): Promise<void> {
    await this.options.backend.dispose();
  }
}
