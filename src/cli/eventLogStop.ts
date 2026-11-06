import type { EventLogStop, EventLogStopReason } from '../protocol/messages.js';

const STOP_REASON_TEXT: Record<EventLogStopReason, string> = {
  bytes: 'byte limit',
  events: 'event limit',
  unknown: 'reason unknown',
};

/** Where the stored log stopped and why: `at seq 12 (byte limit)`. */
export function describeEventLogStop(stop: EventLogStop): string {
  return `at seq ${String(stop.seq)} (${STOP_REASON_TEXT[stop.reason]})`;
}

/** The sentence that a `WAIT_TIMEOUT` message adds when the log has stopped. */
export function eventLogStopTimeoutNote(stop: EventLogStop): string {
  return `The event log stopped ${describeEventLogStop(stop)}, so output after it is not seen.`;
}
