import type { RendererBackend } from './backend.js';
import type { ReplayEvent, ReplayInput, ReplayState } from './types.js';
import { invariant } from '../util/assert.js';

// A replay of a long log can take minutes, and a caller sees nothing of it
// until `replayTo` returns. So the host replays a long backlog in slices and
// reports each finished slice as progress, which keeps `sendRpc` (it gives up
// after 5 s without a byte from the host) waiting while the replay moves and
// lets it fail when the replay stops. A backend that is stuck finishes no
// slice. Any split of the events gives the same backend state, because every
// live render already replays only the events since the one before.
//
// Slice size follows the measured time of the last slice, because replay
// speed differs by 1,000 times between backends and logs. A slice that takes
// 0.5 s leaves 10 times the 5 s of `sendRpc` for a host that runs late. The
// first slice is small, because nothing is known about the speed yet: at the
// 21 ms per event that ghostty-web once took, it is 0.7 s.
export const FIRST_SLICE_EVENTS = 32;
export const TARGET_SLICE_MS = 500;
// A count of events does not bound the time of a slice when the speed depends
// on the bytes that a slice writes. After thousands of tiny events, the size
// has grown, and 500 events of 64 KB would then run for seconds in silence.
// So a slice also holds at most this many bytes of output. One event that is
// larger than this makes a slice alone.
export const MAX_SLICE_BYTES = 1024 * 1024;
// A slice may grow or shrink by this factor at most, so one cheap or costly
// stretch of the log does not make the next slice far too long.
const MAX_SLICE_SCALE = 4;

interface SeqEvent {
  readonly seq: number;
}

/** The number of events with a seq of at most `seq` (events are in seq order). */
export function countEventsThrough(
  events: readonly SeqEvent[],
  seq: number,
): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const event = events[middle];
    invariant(event !== undefined, 'replay event must exist');
    if (event.seq <= seq) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function outputBytes(event: ReplayEvent): number {
  return event.type === 'output' ? Buffer.byteLength(event.payload.data) : 0;
}

/**
 * The index after the last event of the slice that starts at `start`, at most
 * `end`. The slice holds at most `maxEvents` events, and after its first event
 * at most `MAX_SLICE_BYTES` of output.
 */
export function sliceEnd(
  events: readonly ReplayEvent[],
  start: number,
  end: number,
  maxEvents: number,
): number {
  invariant(
    Number.isInteger(maxEvents) && maxEvents > 0,
    'slice event limit must be a positive integer',
  );
  const limit = Math.min(end, start + maxEvents);
  let bytes = 0;
  let index = start;
  while (index < limit) {
    const event = events[index];
    invariant(event !== undefined, 'replay event must exist');
    bytes += outputBytes(event);
    if (index > start && bytes > MAX_SLICE_BYTES) {
      break;
    }
    index += 1;
  }
  return index;
}

export function nextSliceSize(size: number, elapsedMs: number): number {
  invariant(
    Number.isInteger(size) && size > 0,
    'slice size must be a positive integer',
  );
  const scaled = Math.round((size * TARGET_SLICE_MS) / Math.max(elapsedMs, 1));
  return Math.min(
    size * MAX_SLICE_SCALE,
    Math.max(Math.ceil(size / MAX_SLICE_SCALE), scaled),
  );
}

/**
 * Replay `input` to `backend` like `backend.replayTo(input)`, but in slices
 * when many events are left, and call `onReplayed` after each `replayTo`.
 *
 * `appliedSeq` is where the caller last saw the backend. It may be behind the
 * backend, which skips events it holds, but never ahead of it.
 */
export async function replayInSlices(
  backend: Pick<RendererBackend, 'replayTo'>,
  input: ReplayInput,
  appliedSeq: number,
  onReplayed: (state: ReplayState) => void,
  now: () => number = () => performance.now(),
): Promise<void> {
  invariant(
    Number.isInteger(appliedSeq) && appliedSeq >= -1,
    'appliedSeq must be an integer of at least -1',
  );
  const { events } = input;
  // Events past the target are never replayed.
  const end = countEventsThrough(events, input.targetSeq);
  let next = countEventsThrough(events, appliedSeq);
  let size = FIRST_SLICE_EVENTS;
  let stop = sliceEnd(events, next, end, size);

  // The rest fits in one slice when `stop` reaches `end`.
  while (stop < end) {
    const startedAt = now();
    // The slice keeps the target of the whole replay. A lower target would
    // fail on a backend that is ahead of `appliedSeq`, which cannot rewind.
    // The backend ends at the last event that it replays, not at the target.
    const state = await backend.replayTo({
      ...input,
      events: events.slice(next, stop),
    });
    onReplayed(state);
    const reached = countEventsThrough(events, state.lastSeq);
    invariant(
      reached >= stop && reached <= end,
      'a replay slice must end at its last event or at the backend position',
    );
    // Only a slice that the count of events ended says how many events take
    // the target time. The byte limit ended the others, and they hold events
    // of a different cost.
    if (stop - next === size) {
      size = nextSliceSize(size, now() - startedAt);
    }
    // The backend can be ahead of `appliedSeq`, so take its own position.
    next = reached;
    stop = sliceEnd(events, next, end, size);
  }

  // The last call gets the whole input: a backend keeps its last input (the
  // libghostty-vt screenshot replays it in a second renderer), and it skips
  // the events it already holds. The events that are left fit in one slice.
  onReplayed(await backend.replayTo(input));
}
