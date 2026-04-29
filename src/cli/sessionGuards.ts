import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import {
  isCommandableSessionStatus,
  isDestroyedSessionStatus,
} from '../protocol/sessionStatusPolicy.js';
import type { SessionRecord } from '../protocol/schemas.js';
import { invariant } from '../util/assert.js';

/**
 * Throws SESSION_ALREADY_DESTROYED for destroyed sessions and
 * SESSION_NOT_RUNNING for other non-commandable session statuses.
 */
export function assertSessionCommandable(
  manifest: Pick<SessionRecord, 'status'>,
  sessionId: string,
): void {
  invariant(
    typeof sessionId === 'string' && sessionId.length > 0,
    'sessionId must be non-empty',
  );

  if (isDestroyedSessionStatus(manifest.status)) {
    throw makeCliError(ERROR_CODES.SESSION_ALREADY_DESTROYED, {
      message: `Session "${sessionId}" is already destroyed.`,
      details: {
        sessionId,
        status: manifest.status,
      },
    });
  }

  if (!isCommandableSessionStatus(manifest.status)) {
    throw makeCliError(ERROR_CODES.SESSION_NOT_RUNNING, {
      // Preserve the legacy public error text while centralizing the
      // commandable-session policy behind this guard.
      message: `Session "${sessionId}" is not running.`,
      details: {
        sessionId,
        status: manifest.status,
      },
    });
  }
}
