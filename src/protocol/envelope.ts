export interface CommandError {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export interface CommandSuccessEnvelope<TResult> {
  ok: true;
  command: string;
  timestamp: string;
  result: TResult;
}

export interface CommandErrorEnvelope {
  ok: false;
  command: string;
  timestamp: string;
  error: CommandError;
  result?: unknown;
}

export type CommandEnvelope<TResult> =
  | CommandSuccessEnvelope<TResult>
  | CommandErrorEnvelope;

export function createSuccessEnvelope<TResult>(
  command: string,
  result: TResult,
): CommandSuccessEnvelope<TResult> {
  return {
    ok: true,
    command,
    timestamp: new Date().toISOString(),
    result,
  };
}

export function createErrorEnvelope(
  command: string,
  error: CommandError,
  result?: unknown,
): CommandErrorEnvelope {
  return {
    ok: false,
    command,
    timestamp: new Date().toISOString(),
    error,
    ...(result === undefined ? {} : { result }),
  };
}
