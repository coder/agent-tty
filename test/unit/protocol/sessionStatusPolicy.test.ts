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

const POLICY_FIELDS = [
  'active',
  'terminal',
  'commandable',
  'liveHostEligible',
  'offlineReplayEligible',
  'collectable',
  'destroyed',
] as const;

const EXPECTED_STATUS_SETS = {
  active: ['running', 'exiting', 'destroying'],
  terminal: ['exited', 'failed', 'destroyed'],
  commandable: ['running'],
  liveHostEligible: ['running', 'exiting'],
  offlineReplayEligible: ['exited', 'failed', 'destroying', 'destroyed'],
  collectable: ['exited', 'failed', 'destroyed'],
  destroyed: ['destroyed'],
} satisfies Record<(typeof POLICY_FIELDS)[number], readonly SessionStatus[]>;

function expectStatuses(
  predicate: (status: SessionStatus) => boolean,
  expectedStatuses: readonly SessionStatus[],
): void {
  expect(SessionStatusSchema.options.filter(predicate).toSorted()).toEqual(
    expectedStatuses.toSorted(),
  );
}

describe('session status policy', () => {
  it('classifies every session status into documented status sets', () => {
    expectStatuses(isActiveSessionStatus, EXPECTED_STATUS_SETS.active);
    expectStatuses(isTerminalSessionStatus, EXPECTED_STATUS_SETS.terminal);
    expectStatuses(
      isCommandableSessionStatus,
      EXPECTED_STATUS_SETS.commandable,
    );
    expectStatuses(
      isLiveHostEligibleSessionStatus,
      EXPECTED_STATUS_SETS.liveHostEligible,
    );
    expectStatuses(
      isOfflineReplayEligibleSessionStatus,
      EXPECTED_STATUS_SETS.offlineReplayEligible,
    );
    expectStatuses(
      isCollectableSessionStatus,
      EXPECTED_STATUS_SETS.collectable,
    );
    expectStatuses(isDestroyedSessionStatus, EXPECTED_STATUS_SETS.destroyed);
  });

  it('returns complete policy objects that agree with the named predicates', () => {
    for (const status of SessionStatusSchema.options) {
      const policy = getSessionStatusPolicy(status);
      expect(Object.keys(policy).toSorted()).toEqual(POLICY_FIELDS.toSorted());
      expect(policy.active).toBe(isActiveSessionStatus(status));
      expect(policy.terminal).toBe(isTerminalSessionStatus(status));
      expect(policy.commandable).toBe(isCommandableSessionStatus(status));
      expect(policy.liveHostEligible).toBe(
        isLiveHostEligibleSessionStatus(status),
      );
      expect(policy.offlineReplayEligible).toBe(
        isOfflineReplayEligibleSessionStatus(status),
      );
      expect(policy.collectable).toBe(isCollectableSessionStatus(status));
      expect(policy.destroyed).toBe(isDestroyedSessionStatus(status));
    }
  });

  it('preserves the destroying status split between active and offline replay', () => {
    expect(isActiveSessionStatus('destroying')).toBe(true);
    expect(isTerminalSessionStatus('destroying')).toBe(false);
    expect(isOfflineReplayEligibleSessionStatus('destroying')).toBe(true);
    expect(isCollectableSessionStatus('destroying')).toBe(false);
  });
});
