import type { SessionStatus } from './schemas.js';

import { invariant } from '../util/assert.js';

export interface SessionStatusPolicy {
  readonly active: boolean;
  readonly terminal: boolean;
  readonly commandable: boolean;
  readonly liveHostEligible: boolean;
  readonly offlineReplayEligible: boolean;
  readonly collectable: boolean;
  readonly destroyed: boolean;
}

const SESSION_STATUS_POLICIES = {
  running: {
    active: true,
    terminal: false,
    commandable: true,
    liveHostEligible: true,
    offlineReplayEligible: false,
    collectable: false,
    destroyed: false,
  },
  exiting: {
    active: true,
    terminal: false,
    commandable: false,
    liveHostEligible: true,
    offlineReplayEligible: false,
    collectable: false,
    destroyed: false,
  },
  exited: {
    active: false,
    terminal: true,
    commandable: false,
    liveHostEligible: false,
    offlineReplayEligible: true,
    collectable: true,
    destroyed: false,
  },
  failed: {
    active: false,
    terminal: true,
    commandable: false,
    liveHostEligible: false,
    offlineReplayEligible: true,
    collectable: true,
    destroyed: false,
  },
  destroying: {
    active: true,
    terminal: false,
    commandable: false,
    liveHostEligible: false,
    offlineReplayEligible: true,
    collectable: false,
    destroyed: false,
  },
  destroyed: {
    active: false,
    terminal: true,
    commandable: false,
    liveHostEligible: false,
    offlineReplayEligible: true,
    collectable: true,
    destroyed: true,
  },
} satisfies Record<SessionStatus, SessionStatusPolicy>;

for (const [status, policy] of Object.entries(SESSION_STATUS_POLICIES)) {
  invariant(
    !policy.collectable || policy.terminal,
    `${status} collectable sessions must be terminal`,
  );
  invariant(
    !policy.commandable || policy.active,
    `${status} commandable sessions must be active`,
  );
  invariant(
    !(policy.liveHostEligible && policy.offlineReplayEligible),
    `${status} sessions cannot use live-host and offline-replay rendering at once`,
  );
}

export function getSessionStatusPolicy(
  status: SessionStatus,
): SessionStatusPolicy {
  invariant(
    Object.hasOwn(SESSION_STATUS_POLICIES, status),
    `unknown session status: ${status}`,
  );
  return SESSION_STATUS_POLICIES[status];
}

export function isActiveSessionStatus(status: SessionStatus): boolean {
  return getSessionStatusPolicy(status).active;
}

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return getSessionStatusPolicy(status).terminal;
}

export function isCommandableSessionStatus(status: SessionStatus): boolean {
  return getSessionStatusPolicy(status).commandable;
}

export function isLiveHostEligibleSessionStatus(
  status: SessionStatus,
): boolean {
  return getSessionStatusPolicy(status).liveHostEligible;
}

export function isOfflineReplayEligibleSessionStatus(
  status: SessionStatus,
): boolean {
  return getSessionStatusPolicy(status).offlineReplayEligible;
}

export function isCollectableSessionStatus(status: SessionStatus): boolean {
  return getSessionStatusPolicy(status).collectable;
}

export function isDestroyedSessionStatus(status: SessionStatus): boolean {
  return getSessionStatusPolicy(status).destroyed;
}
