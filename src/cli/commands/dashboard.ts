import process from 'node:process';

import type { CommandContext } from '../context.js';

import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';
import {
  assertDashboardRendererAvailable,
  probeLibghosttyVt,
  type LibghosttyVtProbe,
} from '../../renderer/readiness.js';
import type { DashboardScope } from '../../dashboard/sessionScope.js';

export interface DashboardAppOptions {
  home: string;
  scope: DashboardScope;
  sessionId?: string;
}

export interface DashboardCommandOptions {
  context: CommandContext;
  all: boolean;
  session?: string;
}

export interface DashboardCommandDependencies {
  isInteractive?: () => boolean;
  probeRenderer?: () => Promise<LibghosttyVtProbe>;
  runApp?: (options: DashboardAppOptions) => Promise<void>;
}

function defaultIsInteractive(): boolean {
  return process.stdout.isTTY && process.stdin.isTTY;
}

async function defaultRunApp(options: DashboardAppOptions): Promise<void> {
  // Imported lazily so non-dashboard CLI paths never load the Ink/React runtime.
  const { runDashboardApp } = await import('../../dashboard/app.js');
  await runDashboardApp(options);
}

export async function runDashboardCommand(
  options: DashboardCommandOptions,
  dependencies: DashboardCommandDependencies = {},
): Promise<void> {
  const isInteractive = dependencies.isInteractive ?? defaultIsInteractive;
  if (!isInteractive()) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message:
        'agent-tty dashboard requires an interactive terminal: stdin and stdout must both be a TTY. It is interactive-only and does not support --json or piped/CI use.',
    });
  }

  const probe = await (dependencies.probeRenderer ?? probeLibghosttyVt)();
  assertDashboardRendererAvailable(probe);

  const runApp = dependencies.runApp ?? defaultRunApp;
  await runApp({
    home: options.context.home,
    scope: options.all ? 'all' : 'active',
    ...(options.session === undefined ? {} : { sessionId: options.session }),
  });
}
