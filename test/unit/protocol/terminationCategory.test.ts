import { describe, expect, it } from 'vitest';

import { deriveTerminationCategory } from '../../../src/protocol/terminationCategory.js';
import type { SessionRecord } from '../../../src/protocol/schemas.js';

function createSessionRecord(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    version: 1,
    sessionId: 'session-01',
    createdAt: '2026-03-19T12:00:00.000Z',
    updatedAt: '2026-03-19T12:00:01.000Z',
    status: 'running',
    command: ['/bin/sh'],
    cwd: '/tmp/workspace',
    cols: 80,
    rows: 24,
    hostPid: 123,
    childPid: 456,
    exitCode: null,
    exitSignal: null,
    ...overrides,
  };
}

describe('deriveTerminationCategory', () => {
  it('treats running sessions as running', () => {
    expect(deriveTerminationCategory(createSessionRecord())).toBe('running');
  });

  it('treats exiting sessions as running', () => {
    expect(
      deriveTerminationCategory(createSessionRecord({ status: 'exiting' })),
    ).toBe('running');
  });

  it('maps destroyed sessions to destroyed', () => {
    expect(
      deriveTerminationCategory(createSessionRecord({ status: 'destroyed' })),
    ).toBe('destroyed');
  });

  it('maps destroying sessions to destroyed', () => {
    expect(
      deriveTerminationCategory(createSessionRecord({ status: 'destroying' })),
    ).toBe('destroyed');
  });

  it('maps failed host-death sessions to host-death', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'failed',
          failureOrigin: 'host-death',
        }),
      ),
    ).toBe('host-death');
  });

  it('maps failed renderer-failure sessions to renderer-failure', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'failed',
          failureOrigin: 'renderer-failure',
        }),
      ),
    ).toBe('renderer-failure');
  });

  it('maps failed sessions without an origin to unknown', () => {
    expect(
      deriveTerminationCategory(createSessionRecord({ status: 'failed' })),
    ).toBe('unknown');
  });

  it('maps failed sessions with storage-corruption origin to storage-corruption', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'failed',
          failureOrigin: 'storage-corruption',
        }),
      ),
    ).toBe('storage-corruption');
  });

  it('maps failed sessions with storage-corruption failure details to storage-corruption', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'failed',
          failureReason: 'manifest corrupted',
          failureOrigin: 'storage-corruption',
        }),
      ),
    ).toBe('storage-corruption');
  });

  it('maps failed sessions with explicit unknown origin to unknown', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'failed',
          failureReason: 'something unexpected',
          failureOrigin: 'unknown',
        }),
      ),
    ).toBe('unknown');
  });

  it('maps zero-exit sessions to clean-exit', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'exited',
          exitCode: 0,
          exitSignal: null,
        }),
      ),
    ).toBe('clean-exit');
  });

  it('maps null-exit sessions to clean-exit', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'exited',
          exitCode: null,
          exitSignal: null,
        }),
      ),
    ).toBe('clean-exit');
  });

  it('maps non-zero exits to nonzero-exit', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'exited',
          exitCode: 1,
          exitSignal: null,
        }),
      ),
    ).toBe('nonzero-exit');
  });

  it('maps signal exits to signal-exit', () => {
    expect(
      deriveTerminationCategory(
        createSessionRecord({
          status: 'exited',
          exitCode: null,
          exitSignal: 'SIGTERM',
        }),
      ),
    ).toBe('signal-exit');
  });
});
