import { describe, expect, it, vi } from 'vitest';

import { CliError } from '../../../src/cli/errors.js';
import {
  runDashboardCommand,
  type DashboardAppOptions,
} from '../../../src/cli/commands/dashboard.js';
import type { CommandContext } from '../../../src/cli/context.js';

function fakeContext(home = '/tmp/home'): CommandContext {
  // The dashboard command only reads `context.home`.
  return { home } as CommandContext;
}

describe('runDashboardCommand', () => {
  it('fails fast with an actionable error on a non-interactive terminal', async () => {
    const runApp = vi.fn(() => Promise.resolve());
    const probeRenderer = vi.fn(() => Promise.resolve({ available: true }));

    const promise = runDashboardCommand(
      { context: fakeContext(), all: false },
      { isInteractive: () => false, probeRenderer, runApp },
    );

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(/interactive terminal/);
    expect(probeRenderer).not.toHaveBeenCalled();
    expect(runApp).not.toHaveBeenCalled();
  });

  it('fails fast when the libghostty-vt renderer is unavailable', async () => {
    const runApp = vi.fn(() => Promise.resolve());

    const promise = runDashboardCommand(
      { context: fakeContext(), all: false },
      {
        isInteractive: () => true,
        probeRenderer: () =>
          Promise.resolve({
            available: false,
            reason: 'libghostty-vt not installed',
            detail: 'Cannot find package @coder/libghostty-vt-node',
          }),
        runApp,
      },
    );

    await expect(promise).rejects.toThrow(/libghostty-vt-node/);
    expect(runApp).not.toHaveBeenCalled();
  });

  it('runs the app with the resolved scope and preselected session when ready', async () => {
    const calls: DashboardAppOptions[] = [];
    const runApp = vi.fn((options: DashboardAppOptions) => {
      calls.push(options);
      return Promise.resolve();
    });

    await runDashboardCommand(
      { context: fakeContext('/home/agent'), all: true, session: '01J' },
      {
        isInteractive: () => true,
        probeRenderer: () => Promise.resolve({ available: true }),
        runApp,
      },
    );

    expect(calls).toEqual([
      { home: '/home/agent', scope: 'all', sessionId: '01J' },
    ]);
  });

  it('defaults to the active scope without a preselected session', async () => {
    const runApp = vi.fn(() => Promise.resolve());

    await runDashboardCommand(
      { context: fakeContext('/home/agent'), all: false },
      {
        isInteractive: () => true,
        probeRenderer: () => Promise.resolve({ available: true }),
        runApp,
      },
    );

    expect(runApp).toHaveBeenCalledWith({
      home: '/home/agent',
      scope: 'active',
    });
  });
});
