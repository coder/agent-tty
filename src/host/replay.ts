import type { ReplayInput } from '../renderer/types.js';
import {
  SessionRecordSchema,
  type EventRecord,
  type SessionRecord,
} from '../protocol/schemas.js';
import { validateEventRecords } from '../storage/eventLogCodec.js';
import { invariant } from '../util/assert.js';

function assertNonEmptyString(value: string, message: string): void {
  invariant(value.length > 0, message);
}

export function buildReplayInput(
  sessionId: string,
  manifest: SessionRecord,
  events: readonly EventRecord[],
  targetSeq?: number,
  options?: { readonly trustValidated?: boolean },
): ReplayInput {
  assertNonEmptyString(sessionId, 'sessionId must be a non-empty string');

  const parsedManifest = SessionRecordSchema.safeParse(manifest);
  invariant(parsedManifest.success, 'manifest must match SessionRecordSchema');
  invariant(
    parsedManifest.data.sessionId.length > 0,
    'manifest sessionId must be a non-empty string',
  );
  invariant(
    parsedManifest.data.sessionId === sessionId,
    'sessionId must match manifest sessionId',
  );

  const initialCols =
    parsedManifest.data.creationCols ?? parsedManifest.data.cols;
  const initialRows =
    parsedManifest.data.creationRows ?? parsedManifest.data.rows;

  invariant(initialCols > 0, 'initial cols must be positive');
  invariant(initialRows > 0, 'initial rows must be positive');

  // Live-host events come straight from EventLog, which already
  // EventRecordSchema-validated each record and assigned contiguous seqs on
  // append (see eventLog.ts append()). On that trusted path, skip the
  // redundant per-event Zod re-parse and take one cheap shallow copy instead —
  // seq ordering is still enforced downstream by iterateInRangeReplayEvents
  // during replay. Disk-/caller-sourced events (offline replay, webm export)
  // pass no option and remain fully validated here.
  const validatedEvents =
    options?.trustValidated === true
      ? events.slice()
      : validateEventRecords(events);

  let lastSeq = -1;
  if (validatedEvents.length > 0) {
    const lastEvent = validatedEvents.at(-1);
    invariant(lastEvent !== undefined, 'last replay event must exist');
    lastSeq = lastEvent.seq;
  }

  const resolvedTargetSeq = targetSeq ?? lastSeq;

  invariant(
    Number.isInteger(resolvedTargetSeq),
    'targetSeq must be an integer',
  );

  if (validatedEvents.length === 0) {
    invariant(
      resolvedTargetSeq === -1,
      'targetSeq must be -1 when replay has no events',
    );
  } else {
    invariant(resolvedTargetSeq >= 0, 'targetSeq must be non-negative');
    invariant(
      resolvedTargetSeq <= lastSeq,
      'targetSeq must not exceed the last event seq',
    );
  }

  return {
    sessionId,
    initialCols,
    initialRows,
    events: validatedEvents,
    targetSeq: resolvedTargetSeq,
  };
}
