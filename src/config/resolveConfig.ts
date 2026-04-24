import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SHELL,
  EVENT_LOG_FILENAME,
  MANIFEST_FILENAME,
  SOCKET_FILENAME,
} from './defaults.js';
import { resolveHome } from '../storage/home.js';
import { invariant } from '../util/assert.js';

export const ConfigFileSchema = z
  .object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    defaultProfile: z.string().optional(),
    defaultRenderer: z.string().optional(),
    defaultShell: z.string().optional(),
    defaultTerm: z.string().optional(),
    defaultCols: z.number().int().positive().optional(),
    defaultRows: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface AgentTtyConfig {
  readonly home: string;
  readonly cols: number;
  readonly rows: number;
  readonly shell: string;
  readonly socketFilename: string;
  readonly manifestFilename: string;
  readonly eventLogFilename: string;
}

interface NodeError {
  code?: string;
}

function isEnoentError(error: unknown): error is Error & NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeError).code === 'ENOENT'
  );
}

function formatConfigIssues(
  configPath: string,
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): string {
  const formattedIssues = issues.map((issue) => {
    const issuePath = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    return `${issuePath}: ${issue.message}`;
  });

  return `Config file at ${configPath} is invalid: ${formattedIssues.join('; ')}`;
}

export async function loadConfigFile(home: string): Promise<ConfigFile | null> {
  invariant(home.length > 0, 'config home must not be empty');
  invariant(isAbsolute(home), 'config home must be absolute');

  const configPath = join(home, 'config.json');
  let rawConfigFile: string;
  try {
    rawConfigFile = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw new Error(`Failed to read config file at ${configPath}.`, {
      cause: error,
    });
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfigFile) as unknown;
  } catch (error) {
    throw new Error(`Config file at ${configPath} contains invalid JSON.`, {
      cause: error,
    });
  }

  const result = ConfigFileSchema.safeParse(parsedConfig);
  if (!result.success) {
    throw new Error(formatConfigIssues(configPath, result.error.issues), {
      cause: result.error,
    });
  }

  return result.data;
}

export function resolveConfig(): Readonly<AgentTtyConfig> {
  return Object.freeze({
    home: resolveHome(),
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    shell: DEFAULT_SHELL,
    socketFilename: SOCKET_FILENAME,
    manifestFilename: MANIFEST_FILENAME,
    eventLogFilename: EVENT_LOG_FILENAME,
  });
}
