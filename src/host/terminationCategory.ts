import type { TerminationCategory } from '../protocol/messages.js';
import type { SessionRecord } from '../protocol/schemas.js';

export function deriveTerminationCategory(
  session: SessionRecord,
): TerminationCategory {
  switch (session.status) {
    case 'running':
    case 'exiting':
      return 'running';
    case 'destroying':
    case 'destroyed':
      return 'destroyed';
    case 'failed':
      switch (session.failureOrigin) {
        case 'host-death':
          return 'host-death';
        case 'renderer-failure':
          return 'renderer-failure';
        default:
          return 'unknown';
      }
    case 'exited':
      if (session.exitSignal !== null) {
        return 'signal-exit';
      }
      if (session.exitCode === 0 || session.exitCode === null) {
        return 'clean-exit';
      }
      return 'nonzero-exit';
    default:
      return 'unknown';
  }
}
