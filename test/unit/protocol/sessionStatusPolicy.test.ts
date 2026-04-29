import { describe, expect, it } from 'vitest';

import {
  getSessionStatusPolicy,
  isActiveSessionStatus,
  isCollectableSessionStatus,
  isCommandableSessionStatus,
  isDestroyedSessionStatus,
  isLiveHostEligibleSessionStatus,
  isOfflineReplayEligibleSessionStatus,
  isTerminalSessionStatus,
} from '../../../src/protocol/sessionStatusPolicy.js';
import type { SessionStatus } from '../../../src/protocol/schemas.js';
import { SessionStatusSchema } from '../../../src/protocol/schemas.js';

const EXPECTED_POLICIES = {
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
} satisfies Record<SessionStatus, ReturnType<typeof getSessionStatusPolicy>>;

describe('session status policy', () => {
  it('classifies every session status explicitly', () => {
    expect(Object.keys(EXPECTED_POLICIES).sort()).toEqual(
      [...SessionStatusSchema.options].sort(),
    );

    for (const status of SessionStatusSchema.options) {
      expect(getSessionStatusPolicy(status)).toEqual(EXPECTED_POLICIES[status]);
    }
  });

  it('exposes named predicates for callers', () => {
    for (const status of SessionStatusSchema.options) {
      const expected = EXPECTED_POLICIES[status];
      expect(isActiveSessionStatus(status)).toBe(expected.active);
      expect(isTerminalSessionStatus(status)).toBe(expected.terminal);
      expect(isCommandableSessionStatus(status)).toBe(expected.commandable);
      expect(isLiveHostEligibleSessionStatus(status)).toBe(
        expected.liveHostEligible,
      );
      expect(isOfflineReplayEligibleSessionStatus(status)).toBe(
        expected.offlineReplayEligible,
      );
      expect(isCollectableSessionStatus(status)).toBe(expected.collectable);
      expect(isDestroyedSessionStatus(status)).toBe(expected.destroyed);
    }
  });

  it('preserves the destroying status split between active and offline replay', () => {
    expect(isActiveSessionStatus('destroying')).toBe(true);
    expect(isTerminalSessionStatus('destroying')).toBe(false);
    expect(isOfflineReplayEligibleSessionStatus('destroying')).toBe(true);
    expect(isCollectableSessionStatus('destroying')).toBe(false);
  });
});
