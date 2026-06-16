import type { ReplayInput } from './types.js';
import { invariant } from '../util/assert.js';

type ReplayEvent = ReplayInput['events'][number];

/**
 * Yield the replay events that fall in the half-open range
 * (lastAppliedSeq, targetSeq], in order. Enforces the seq invariants shared by
 * every renderer backend: each event seq is a non-negative integer, seqs are
 * strictly increasing across ALL events (including skipped ones), events at or
 * below lastAppliedSeq are skipped, and iteration stops at the first event
 * beyond targetSeq. Callers dispatch on event.type and own how output is fed.
 */
export function* iterateInRangeReplayEvents(
  input: ReplayInput,
  lastAppliedSeq: number,
): Generator<ReplayEvent> {
  let previousEventSeq = -1;
  for (const event of input.events) {
    invariant(
      Number.isInteger(event.seq) && event.seq >= 0,
      'replay event seq must be a non-negative integer',
    );
    invariant(
      event.seq > previousEventSeq,
      'replay events must be ordered by strictly increasing seq values',
    );
    previousEventSeq = event.seq;

    if (event.seq <= lastAppliedSeq) {
      continue;
    }
    if (event.seq > input.targetSeq) {
      return;
    }
    yield event;
  }
}
