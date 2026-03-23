import { isAbsolute, normalize } from 'node:path';
import process from 'node:process';

import type { Command } from 'commander';

import { DEFAULT_LOG_LEVEL } from '../config/defaults.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { resolveHome } from '../storage/home.js';
import { invariant } from '../util/assert.js';

const COMMAND_CONTEXT_SYMBOL = Symbol('commandContext');

const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVEL_VALUES)[number];

export interface GlobalCliOptions {
  home?: string;
  timeoutMs?: number;
  color?: boolean;
  logLevel?: string;
  profileDefault?: string;
}

export interface CommandContext {
  readonly home: string;
  readonly timeoutMs: number | undefined;
  readonly colorEnabled: boolean;
  readonly logLevel: LogLevel;
  readonly profileDefault: string | undefined;
}

interface CommandWithContext extends Command {
  [COMMAND_CONTEXT_SYMBOL]?: CommandContext;
}

function validateHomePath(home: string, source: string): string {
  if (home.length === 0) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: `${source} must not be empty.`,
      details: {
        source,
      },
    });
  }

  if (!isAbsolute(home)) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: `${source} must be an absolute path.`,
      details: {
        source,
        home,
      },
    });
  }

  return normalize(home);
}

export function parseTimeoutMsOption(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw makeCliError(ERROR_CODES.INVALID_DURATION, {
      message: '--timeout-ms must be a non-negative integer.',
      details: {
        timeoutMs: value,
      },
    });
  }

  const parsedValue = Number.parseInt(value, 10);
  invariant(
    Number.isSafeInteger(parsedValue),
    'timeoutMs must be a safe integer',
  );

  return parsedValue;
}

export function resolveLogLevel(raw?: string): LogLevel {
  if (raw === undefined) {
    return DEFAULT_LOG_LEVEL;
  }

  if ((LOG_LEVEL_VALUES as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }

  throw makeCliError(ERROR_CODES.INVALID_INPUT, {
    message: 'Log level must be one of debug, info, warn, or error.',
    details: {
      logLevel: raw,
      allowedValues: LOG_LEVEL_VALUES,
    },
  });
}

export function resolveCommandContext(
  options: GlobalCliOptions,
  env: NodeJS.ProcessEnv = process.env,
): CommandContext {
  const configuredHome = options.home ?? env.AGENT_TERMINAL_HOME;
  const home =
    configuredHome === undefined
      ? resolveHome(env.AGENT_TERMINAL_HOME)
      : validateHomePath(
          configuredHome,
          options.home !== undefined ? '--home' : 'AGENT_TERMINAL_HOME',
        );
  const logLevel = resolveLogLevel(
    options.logLevel ?? env.AGENT_TERMINAL_LOG_LEVEL,
  );
  const profileDefault = options.profileDefault ?? env.AGENT_TERMINAL_PROFILE;

  return Object.freeze({
    home,
    timeoutMs: options.timeoutMs,
    colorEnabled: options.color ?? true,
    logLevel,
    profileDefault,
  });
}

function getRootCommand(command: Command): CommandWithContext {
  let current: Command = command;
  while (current.parent !== null) {
    current = current.parent;
  }

  return current as CommandWithContext;
}

export function setCommandContext(
  command: Command,
  context: CommandContext,
): CommandContext {
  const rootCommand = getRootCommand(command);
  rootCommand[COMMAND_CONTEXT_SYMBOL] = context;
  return context;
}

export function getCommandContext(command: Command): CommandContext {
  const rootCommand = getRootCommand(command);
  const cachedContext = rootCommand[COMMAND_CONTEXT_SYMBOL];
  if (cachedContext !== undefined) {
    return cachedContext;
  }

  const context = resolveCommandContext(
    command.optsWithGlobals<GlobalCliOptions>(),
  );
  return setCommandContext(command, context);
}
