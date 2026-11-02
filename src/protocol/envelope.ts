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

export interface CommandErrorEnvelope<TResult = never> {
  ok: false;
  command: string;
  timestamp: string;
  error: CommandError;
  result?: TResult;
}

export type CommandEnvelope<TResult, TErrorResult = never> =
  | CommandSuccessEnvelope<TResult>
  | CommandErrorEnvelope<TErrorResult>;

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

export function createErrorEnvelope<TResult = never>(
  command: string,
  error: CommandError,
  result?: TResult,
): CommandErrorEnvelope<TResult> {
  return {
    ok: false,
    command,
    timestamp: new Date().toISOString(),
    error,
    ...(result === undefined ? {} : { result }),
  };
}
