import type { CliError } from '../cli/errors.js';

import { CliError as CliErrorClass } from '../cli/errors.js';

export const ERROR_CODES = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_RUNNING: 'SESSION_NOT_RUNNING',
  SESSION_ALREADY_DESTROYED: 'SESSION_ALREADY_DESTROYED',
  HOST_UNREACHABLE: 'HOST_UNREACHABLE',
  HOST_TIMEOUT: 'HOST_TIMEOUT',
  INVALID_SESSION_ID: 'INVALID_SESSION_ID',
  INVALID_DIMENSIONS: 'INVALID_DIMENSIONS',
  INVALID_SIGNAL: 'INVALID_SIGNAL',
  INVALID_KEYS: 'INVALID_KEYS',
  INVALID_DURATION: 'INVALID_DURATION',
  INVALID_INPUT: 'INVALID_INPUT',
  STORAGE_READ_ERROR: 'STORAGE_READ_ERROR',
  STORAGE_WRITE_ERROR: 'STORAGE_WRITE_ERROR',
  MANIFEST_VALIDATION_ERROR: 'MANIFEST_VALIDATION_ERROR',
  RPC_ERROR: 'RPC_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ProtocolErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const DEFAULT_ERROR_MESSAGES: Record<ProtocolErrorCode, string> = {
  [ERROR_CODES.SESSION_NOT_FOUND]: 'Session not found.',
  [ERROR_CODES.SESSION_NOT_RUNNING]: 'Session is not running.',
  [ERROR_CODES.SESSION_ALREADY_DESTROYED]: 'Session is already destroyed.',
  [ERROR_CODES.HOST_UNREACHABLE]: 'Session host is unreachable.',
  [ERROR_CODES.HOST_TIMEOUT]: 'Session host timed out.',
  [ERROR_CODES.INVALID_SESSION_ID]: 'Session ID is invalid.',
  [ERROR_CODES.INVALID_DIMENSIONS]: 'Terminal dimensions are invalid.',
  [ERROR_CODES.INVALID_SIGNAL]: 'Signal is invalid.',
  [ERROR_CODES.INVALID_KEYS]: 'Key sequence is invalid.',
  [ERROR_CODES.INVALID_DURATION]: 'Duration value is invalid.',
  [ERROR_CODES.INVALID_INPUT]: 'Invalid input provided.',
  [ERROR_CODES.STORAGE_READ_ERROR]: 'Failed to read session storage.',
  [ERROR_CODES.STORAGE_WRITE_ERROR]: 'Failed to write session storage.',
  [ERROR_CODES.MANIFEST_VALIDATION_ERROR]: 'Session manifest is invalid.',
  [ERROR_CODES.RPC_ERROR]: 'RPC request failed.',
  [ERROR_CODES.PROTOCOL_ERROR]: 'Unexpected response from host.',
  [ERROR_CODES.INTERNAL_ERROR]: 'Internal error.',
};

const DEFAULT_RETRYABLE_CODES: ReadonlySet<ProtocolErrorCode> = new Set([
  ERROR_CODES.HOST_UNREACHABLE,
  ERROR_CODES.HOST_TIMEOUT,
  ERROR_CODES.RPC_ERROR,
]);

export interface MakeCliErrorOptions {
  message?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export function makeCliError(
  code: ProtocolErrorCode,
  overrides: MakeCliErrorOptions = {},
): CliError {
  const options: {
    retryable?: boolean;
    details?: Record<string, unknown>;
    cause?: unknown;
  } = {
    retryable: overrides.retryable ?? DEFAULT_RETRYABLE_CODES.has(code),
  };

  if (overrides.details !== undefined) {
    options.details = overrides.details;
  }

  if (overrides.cause !== undefined) {
    options.cause = overrides.cause;
  }

  return new CliErrorClass(
    code,
    overrides.message ?? DEFAULT_ERROR_MESSAGES[code],
    options,
  );
}
