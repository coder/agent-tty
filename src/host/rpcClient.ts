import { randomUUID } from 'node:crypto';
import net from 'node:net';

import { CliError } from '../cli/errors.js';
import {
  ERROR_CODES,
  makeCliError,
  type ProtocolErrorCode,
} from '../protocol/errors.js';
import {
  MAX_RPC_RESPONSE_CHARS,
  RpcMethodSchemas,
  RpcRequestSchema,
  RpcResponseSchema,
  type RpcMethod,
} from '../protocol/messages.js';
import {
  addAbortListener,
  createResourceScopedSettlers,
  makeAbortError,
  throwIfAborted,
} from '../util/abort.js';
import { legacySocketPath } from '../storage/sessionPaths.js';
import { invariant } from '../util/assert.js';
import { ResourceScope } from '../util/resourceScope.js';
import { isOwnLegacySocket, socketRootExists } from './socketRoot.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const HOST_UNREACHABLE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'ECONNRESET',
]);

function isKnownRpcMethod(method: string): method is RpcMethod {
  return Object.hasOwn(RpcMethodSchemas, method);
}

function isProtocolErrorCode(code: string): code is ProtocolErrorCode {
  return Object.values(ERROR_CODES).includes(code as ProtocolErrorCode);
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return fallback;
}

function toTransportCliError(
  error: unknown,
  socketPath: string,
  method: string,
  timeoutMs: number,
): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof Error && 'code' in error) {
    const errorCode = typeof error.code === 'string' ? error.code : undefined;

    if (
      errorCode !== undefined &&
      HOST_UNREACHABLE_SOCKET_CODES.has(errorCode)
    ) {
      return makeCliError(ERROR_CODES.HOST_UNREACHABLE, {
        message: `Failed to reach RPC host at ${socketPath}.`,
        details: {
          method,
          socketPath,
          errno: errorCode,
        },
        cause: error,
      });
    }
  }

  return makeCliError(ERROR_CODES.RPC_ERROR, {
    message: toErrorMessage(
      error,
      `RPC request failed for method "${method}".`,
    ),
    details: {
      method,
      socketPath,
      timeoutMs,
    },
    cause: error,
  });
}

function toResponseCliError(
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
): CliError {
  if (isProtocolErrorCode(code)) {
    return makeCliError(code, { message, ...(details && { details }) });
  }

  return new CliError(code, message, { ...(details && { details }) });
}

function isMissingSocket(error: unknown): boolean {
  return (
    error instanceof CliError &&
    error.code === ERROR_CODES.HOST_UNREACHABLE &&
    error.details.errno === 'ENOENT'
  );
}

export async function sendRpc(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  // A host that an older version started listens at the old path. Remove
  // this fallback after one minor release.
  const oldSocketPath = legacySocketPath(socketPath);
  if (oldSocketPath === null) {
    return await sendRpcAt(socketPath, method, params, timeoutMs, signal);
  }
  // A missing root, or one that another user holds, has no socket of ours.
  let rootError: unknown = toTransportCliError(
    Object.assign(new Error(`connect ENOENT ${socketPath}`), {
      code: 'ENOENT',
    }),
    socketPath,
    method,
    timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let rootUsable = false;
  try {
    rootUsable = await socketRootExists();
  } catch (error) {
    rootError = error;
  }
  if (rootUsable) {
    try {
      return await sendRpcAt(socketPath, method, params, timeoutMs, signal);
    } catch (error) {
      if (!isMissingSocket(error)) {
        throw error;
      }
      rootError = error;
    }
  }
  if (!(await isOwnLegacySocket(oldSocketPath))) {
    throw rootError;
  }
  return await sendRpcAt(oldSocketPath, method, params, timeoutMs, signal);
}

async function sendRpcAt(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  invariant(
    Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs >= 0,
    'RPC timeout must be a non-negative finite number.',
  );

  const requestResult = RpcRequestSchema.safeParse({
    id: randomUUID(),
    method,
    params: params ?? {},
  });
  invariant(
    requestResult.success,
    'Outbound RPC request must satisfy RpcRequestSchema.',
  );

  const request = requestResult.data;

  return await new Promise<unknown>((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    const scope = new ResourceScope();
    scope.add('rpc client socket', () => {
      socket.destroy();
    });
    const settlers = createResourceScopedSettlers(scope, resolve, reject);
    let responseHandled = false;
    let buffer = '';

    const rejectWithTransportError = (error: unknown): void => {
      settlers.reject(
        toTransportCliError(error, socketPath, method, effectiveTimeoutMs),
      );
    };

    if (signal !== undefined) {
      addAbortListener(scope, 'rpc client abort listener', signal, () => {
        settlers.reject(makeAbortError(signal));
      });
    }

    socket.setEncoding('utf8');
    socket.setTimeout(effectiveTimeoutMs);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('timeout', () => {
      settlers.reject(
        makeCliError(ERROR_CODES.HOST_TIMEOUT, {
          message: `RPC request timed out after ${String(effectiveTimeoutMs)}ms.`,
          details: {
            method,
            socketPath,
            timeoutMs: effectiveTimeoutMs,
          },
        }),
      );
    });

    socket.on('error', (error) => {
      rejectWithTransportError(error);
    });

    socket.on('data', (chunk: string) => {
      if (responseHandled) {
        return;
      }

      if (buffer.length + chunk.length > MAX_RPC_RESPONSE_CHARS) {
        settlers.reject(
          makeCliError(ERROR_CODES.RPC_ERROR, {
            message: 'RPC response exceeds maximum buffer size.',
            details: { method, socketPath },
          }),
        );
        return;
      }

      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');

      if (newlineIndex < 0) {
        return;
      }

      responseHandled = true;
      const line = buffer.slice(0, newlineIndex);

      try {
        const rawResponse = JSON.parse(line) as unknown;
        const responseResult = RpcResponseSchema.safeParse(rawResponse);

        if (!responseResult.success) {
          settlers.reject(
            makeCliError(ERROR_CODES.RPC_ERROR, {
              message: 'RPC response failed schema validation.',
              details: {
                method,
                socketPath,
              },
              cause: responseResult.error,
            }),
          );
          return;
        }

        const response = responseResult.data;

        if (response.id !== request.id) {
          settlers.reject(
            makeCliError(ERROR_CODES.RPC_ERROR, {
              message: `RPC response id mismatch for method "${method}".`,
              details: {
                method,
                socketPath,
                expectedId: request.id,
                actualId: response.id,
              },
            }),
          );
          return;
        }

        if (response.ok) {
          if (isKnownRpcMethod(method)) {
            const resultResult = RpcMethodSchemas[method].result.safeParse(
              response.result,
            );

            if (!resultResult.success) {
              settlers.reject(
                makeCliError(ERROR_CODES.RPC_ERROR, {
                  message: `RPC result failed validation for method "${method}".`,
                  details: {
                    method,
                    socketPath,
                  },
                  cause: resultResult.error,
                }),
              );
              return;
            }

            settlers.resolve(resultResult.data);
            return;
          }

          settlers.resolve(response.result);
          return;
        }

        settlers.reject(
          toResponseCliError(
            response.error.code,
            response.error.message,
            response.error.details,
          ),
        );
      } catch (error) {
        settlers.reject(
          makeCliError(ERROR_CODES.RPC_ERROR, {
            message: toErrorMessage(
              error,
              `Failed to decode RPC response for method "${method}".`,
            ),
            details: {
              method,
              socketPath,
            },
            cause: error,
          }),
        );
      }
    });

    socket.on('end', () => {
      if (settlers.isSettled() || responseHandled) {
        return;
      }

      settlers.reject(
        makeCliError(ERROR_CODES.RPC_ERROR, {
          message: `RPC connection closed before a complete response was received for method "${method}".`,
          details: {
            method,
            socketPath,
          },
        }),
      );
    });
  });
}
