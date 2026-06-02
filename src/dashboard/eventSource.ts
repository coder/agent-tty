import { open, stat } from 'node:fs/promises';

import { EventRecordSchema, type EventRecord } from '../protocol/schemas.js';
import { hasErrorCode } from '../util/hasErrorCode.js';

const LINE_FEED = 0x0a;

/**
 * Whether a Session's Event Log is present and being followed.
 *
 * - `pending`: the Event Log has never been observed (the Session may be
 *   starting up and has not written its first entry yet).
 * - `active`: the Event Log is present; entries are being read.
 * - `collected`: the Event Log was present and has since been removed (the
 *   Session was garbage-collected / its **Collectable Session** directory was
 *   reclaimed). The **Live View** should freeze and the **Session** drops out
 *   of the list on the next refresh.
 */
export type SessionEventSourceState = 'pending' | 'active' | 'collected';

/** One batch of newly-appended Event Log entries plus the source's state. */
export interface SessionEventBatch {
  records: EventRecord[];
  state: SessionEventSourceState;
}

/**
 * A source of **Event Log** entries for a single **Session**, consumed by
 * **Event Log Follow**. The v1 implementation tails `events.jsonl` from disk
 * ({@link EventLogTailSource}); a future streaming subscribe transport can
 * implement this same interface without touching the **Live View** (ADR 0006).
 */
export interface SessionEventSource {
  /** Pull any Event Log entries appended since the previous poll. */
  poll(): Promise<SessionEventBatch>;
}

export class EventLogTailSource implements SessionEventSource {
  private offset = 0;
  private partial = Buffer.alloc(0);
  private everPresent = false;

  constructor(private readonly path: string) {}

  async poll(): Promise<SessionEventBatch> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        // A log we have read before and is now gone was collected; one we have
        // never seen is simply not created yet. Reset the read position so a log
        // later (re)created at this path is read from the start rather than
        // resuming at a stale byte offset.
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        return {
          records: [],
          state: this.everPresent ? 'collected' : 'pending',
        };
      }
      throw error;
    }
    this.everPresent = true;

    if (size < this.offset) {
      // The log was truncated or rewritten; start over from the beginning.
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size === this.offset) {
      return { records: [], state: 'active' };
    }

    const length = size - this.offset;
    const chunk = Buffer.alloc(length);
    const handle = await open(this.path, 'r');
    try {
      const { bytesRead } = await handle.read(chunk, 0, length, this.offset);
      this.offset += bytesRead;
      this.partial = Buffer.concat([
        this.partial,
        chunk.subarray(0, bytesRead),
      ]);
    } finally {
      await handle.close();
    }

    return { records: this.drainCompleteLines(), state: 'active' };
  }

  /**
   * Decode and parse only newline-terminated lines, keeping any trailing
   * partial line buffered as raw bytes (so a multibyte sequence split across
   * reads is never decoded mid-character).
   */
  private drainCompleteLines(): EventRecord[] {
    const records: EventRecord[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.partial.indexOf(LINE_FEED)) !== -1) {
      const line = this.partial
        .subarray(0, newlineIndex)
        .toString('utf8')
        .trim();
      this.partial = this.partial.subarray(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      // A complete line that is not a valid Event Log entry is corruption, not
      // a torn write. Skip it rather than crashing the read-only Live View.
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = EventRecordSchema.safeParse(value);
      if (parsed.success) {
        records.push(parsed.data);
      }
    }
    return records;
  }
}
