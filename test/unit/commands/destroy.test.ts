import { EventEmitter } from 'node:events';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cliRunsInsideProgramSession: vi.fn(),
  destroySession: vi.fn(),
  emitSuccess: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

vi.mock('../../../src/cli/output.js', () => ({
  emitSuccess: mocks.emitSuccess,
}));

vi.mock('../../../src/host/lifecycle.js', () => ({
  cliRunsInsideProgramSession: mocks.cliRunsInsideProgramSession,
  destroySession: mocks.destroySession,
}));

import { runDestroyCommand } from '../../../src/cli/commands/destroy.js';

const OPTIONS = { json: true, sessionId: 'session-01', force: false };
const MAX_SPAWNS = 5;

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('destroy command', () => {
  it('a re-run copy never starts a copy of its own, even when its check says inside', async () => {
    mocks.cliRunsInsideProgramSession.mockResolvedValue(true);
    mocks.destroySession.mockResolvedValue(undefined);
    // Each spawn runs the copy in this process with the environment that
    // its parent gave it, so a copy that re-runs spawns again.
    mocks.spawn.mockImplementation(
      (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter();
        if (mocks.spawn.mock.calls.length > MAX_SPAWNS) {
          setImmediate(() => child.emit('exit', 1));
          return child;
        }
        const parentEnv = process.env;
        process.env = options.env;
        void runDestroyCommand(OPTIONS).finally(() => {
          process.env = parentEnv;
          child.emit('exit', 0);
        });
        return child;
      },
    );

    await runDestroyCommand(OPTIONS);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true });
    expect(mocks.destroySession).toHaveBeenCalledTimes(1);
    expect(mocks.destroySession).toHaveBeenCalledWith('session-01', false);
    expect(mocks.emitSuccess).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });
});
