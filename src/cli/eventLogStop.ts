import { readEventLogStop } from '../host/eventLog.js';
import type { EventLogStop, EventLogStopReason } from '../protocol/messages.js';
import { eventLogPath } from '../storage/sessionPaths.js';

const STOP_REASON_TEXT: Record<EventLogStopReason, string> = {
  bytes: 'byte limit',
  events: 'event limit',
};

/** Where the stored log stopped and why: `at seq 12 (byte limit)`. */
export function describeEventLogStop(stop: EventLogStop): string {
  return `at seq ${String(stop.seq)} (${STOP_REASON_TEXT[stop.reason]})`;
}

/** The sentence that a `WAIT_TIMEOUT` message adds when the log has stopped. */
export function eventLogStopTimeoutNote(stop: EventLogStop): string {
  return `The event log stopped ${describeEventLogStop(stop)}, so output after it is not seen.`;
}

/**
 * Reads where the stored log of a session stopped, for the message of a wait
 * that timed out. The note is extra: a log that cannot be read leaves the
 * `WAIT_TIMEOUT` it explains as it is.
 */
export async function readEventLogStopForTimeout(
  sessionDirectory: string,
): Promise<EventLogStop | undefined> {
  try {
    return await readEventLogStop(eventLogPath(sessionDirectory));
  } catch {
    return undefined;
  }
}
