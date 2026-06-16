import { realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import process from 'node:process';

import type { Command } from 'commander';

import { loadConfigFile, type ConfigFile } from '../config/resolveConfig.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import {
  DEFAULT_RENDERER_NAME,
  DEFAULT_SEMANTIC_RENDERER_NAME,
  DEFAULT_VISUAL_RENDERER_NAME,
  RendererNameSchema,
  resolveRendererName,
  type RendererName,
} from '../renderer/names.js';
import {
  probeLibghosttyVt,
  type LibghosttyVtProbe,
} from '../renderer/readiness.js';
import { resolveHome } from '../storage/home.js';
import { invariant } from '../util/assert.js';
import {
  createLogger,
  resolveLogLevel as resolveLoggerLevel,
  type LogLevel,
} from '../util/logger.js';

const COMMAND_CONTEXT_SYMBOL = Symbol('commandContext');

export interface GlobalCliOptions {
  home?: string;
  timeoutMs?: number;
  color?: boolean;
  logLevel?: string;
  profile?: string;
  profileDefault?: string;
  renderer?: string;
}

export interface CommandContext {
  readonly home: string;
  /** Whether `home` was explicitly selected (`--home`/`AGENT_TTY_HOME`) rather
   * than defaulted. gc uses this to scope to one Home vs. sweeping the registry. */
  readonly explicitHome: boolean;
  readonly timeoutMs: number | undefined;
  readonly colorEnabled: boolean;
  readonly logLevel: LogLevel;
  readonly logger: ReturnType<typeof createLogger>;
  readonly profileDefault: string | undefined;
  /** Default renderer for semantic operations: snapshot, render waits, hashes. */
  readonly rendererDefault: RendererName;
  /** Default renderer for visual artifacts: PNG screenshots and WebM exports. */
  readonly rendererVisualDefault: RendererName;
  readonly configFile: ConfigFile | null;
}

interface RendererDefaultResolutionDeps {
  probeLibghosttyVt?: () => Promise<LibghosttyVtProbe>;
}

interface RendererDefaults {
  readonly semantic: RendererName;
  readonly visual: RendererName;
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

  const normalized = normalize(home);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
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

export function resolveRendererDefault(raw?: string): RendererName {
  try {
    return resolveRendererName(raw ?? DEFAULT_RENDERER_NAME);
  } catch (error) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Renderer must be one of: ghostty-web, libghostty-vt.',
      details: { renderer: raw },
      cause: error,
    });
  }
}

let automaticSemanticRendererName: Promise<RendererName> | undefined;

async function resolveAutomaticSemanticRenderer(
  deps: RendererDefaultResolutionDeps,
): Promise<RendererName> {
  const probe = deps.probeLibghosttyVt ?? probeLibghosttyVt;
  const resolveFromProbe = async (): Promise<RendererName> => {
    try {
      const probeResult = await probe();
      return probeResult.available
        ? DEFAULT_SEMANTIC_RENDERER_NAME
        : DEFAULT_RENDERER_NAME;
    } catch {
      return DEFAULT_RENDERER_NAME;
    }
  };

  if (deps.probeLibghosttyVt !== undefined) {
    return resolveFromProbe();
  }

  automaticSemanticRendererName ??= resolveFromProbe();
  return automaticSemanticRendererName;
}

export function clearRendererDefaultProbeCacheForTests(): void {
  automaticSemanticRendererName = undefined;
}

async function resolveRendererDefaults(
  configuredRenderer: string | undefined,
  deps: RendererDefaultResolutionDeps,
): Promise<RendererDefaults> {
  if (configuredRenderer !== undefined) {
    const renderer = resolveRendererDefault(configuredRenderer);
    invariant(
      RendererNameSchema.safeParse(renderer).success,
      'configured renderer default must be a valid renderer name',
    );
    return { semantic: renderer, visual: renderer };
  }

  const semantic = await resolveAutomaticSemanticRenderer(deps);
  const visual = DEFAULT_VISUAL_RENDERER_NAME;
  invariant(
    RendererNameSchema.safeParse(semantic).success,
    'semantic renderer default must be a valid renderer name',
  );
  invariant(
    RendererNameSchema.safeParse(visual).success,
    'visual renderer default must be a valid renderer name',
  );
  return { semantic, visual };
}

export function resolveLogLevel(raw?: string): LogLevel {
  try {
    return resolveLoggerLevel(raw);
  } catch (error) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'Log level must be one of debug, info, warn, or error.',
      details: {
        logLevel: raw,
      },
      cause: error,
    });
  }
}

export async function resolveCommandContext(
  options: GlobalCliOptions,
  env: NodeJS.ProcessEnv = process.env,
  deps: RendererDefaultResolutionDeps = {},
): Promise<CommandContext> {
  const configuredHome = options.home ?? env.AGENT_TTY_HOME;
  const explicitHome = configuredHome !== undefined;
  const home =
    configuredHome === undefined
      ? resolveHome(env.AGENT_TTY_HOME)
      : validateHomePath(
          configuredHome,
          options.home !== undefined ? '--home' : 'AGENT_TTY_HOME',
        );
  const configFile = await loadConfigFile(home);
  const logLevel = resolveLogLevel(
    options.logLevel ?? env.AGENT_TTY_LOG_LEVEL ?? configFile?.logLevel,
  );
  const logger = createLogger(logLevel);
  const profileDefault =
    options.profileDefault ??
    options.profile ??
    env.AGENT_TTY_PROFILE ??
    configFile?.defaultProfile;
  const rendererDefaults = await resolveRendererDefaults(
    options.renderer ?? env.AGENT_TTY_RENDERER ?? configFile?.defaultRenderer,
    deps,
  );

  return Object.freeze({
    home,
    explicitHome,
    timeoutMs: options.timeoutMs,
    colorEnabled: options.color ?? true,
    logLevel,
    logger,
    profileDefault,
    rendererDefault: rendererDefaults.semantic,
    rendererVisualDefault: rendererDefaults.visual,
    configFile,
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

export async function getCommandContext(
  command: Command,
): Promise<CommandContext> {
  const rootCommand = getRootCommand(command);
  const cachedContext = rootCommand[COMMAND_CONTEXT_SYMBOL];
  if (cachedContext !== undefined) {
    return cachedContext;
  }

  const context = await resolveCommandContext(
    command.optsWithGlobals<GlobalCliOptions>(),
  );
  return setCommandContext(command, context);
}
