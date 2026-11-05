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

const OPTIONS = {
  home: '/tmp/agent-tty-home',
  json: true,
  sessionId: 'session-01',
  force: false,
};
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

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'forwards %s to the copy and exits as the copy does',
    async (signal, exitCode) => {
      mocks.cliRunsInsideProgramSession.mockResolvedValue(true);
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn((sent: NodeJS.Signals) => {
          setImmediate(() => child.emit('exit', null, sent));
          return true;
        }),
      });
      mocks.spawn.mockReturnValue(child);
      const listeners = process.listenerCount(signal);

      const destroy = runDestroyCommand(OPTIONS);
      await vi.waitFor(() => {
        expect(mocks.spawn).toHaveBeenCalledOnce();
      });
      process.emit(signal, signal);
      await vi.waitFor(() => {
        expect(child.kill).toHaveBeenCalledWith(signal);
      });
      await destroy;

      expect(process.exitCode).toBe(exitCode);
      expect(process.listenerCount(signal)).toBe(listeners);
      expect(mocks.destroySession).not.toHaveBeenCalled();
    },
  );
  // The end of the program's session hangs up the CLI that waits inside it,
  // and the copy must outlive that to report the destroy.
  it('does not forward SIGHUP to the copy', async () => {
    mocks.cliRunsInsideProgramSession.mockResolvedValue(true);
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockReturnValue(child);
    const listeners = process.listenerCount('SIGHUP');

    const destroy = runDestroyCommand(OPTIONS);
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledOnce();
    });

    expect(process.listenerCount('SIGHUP')).toBe(listeners);
    process.listeners('SIGHUP').forEach((listener) => {
      listener('SIGHUP');
    });
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('exit', 0, null);
    await destroy;
    expect(process.exitCode).toBe(0);
  });
});
