import { chmod, stat, unlink } from 'node:fs/promises';
import net from 'node:net';

import { CliError } from '../cli/errors.js';
import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import {
  MAX_RPC_REQUEST_ID_CHARS,
  MAX_RPC_RESPONSE_CHARS,
  RpcMethodSchemas,
  RpcRequestSchema,
  RpcResponseSchema,
  type RpcMethod,
  type RpcResponse,
} from '../protocol/messages.js';
import {
  createResourceScopedSettlers,
  makeAbortReason,
} from '../util/abort.js';
import { invariant } from '../util/assert.js';
import { ResourceScope } from '../util/resourceScope.js';

const MAX_UNIX_SOCKET_PATH = 104;
const MAX_RPC_REQUEST_CHARS = 1_048_576;
const MAX_RPC_ERROR_DETAILS_CHARS = 65_536;
const MAX_RPC_ERROR_MESSAGE_CHARS = 65_536;
const TRUNCATED_MESSAGE_SUFFIX = ' [message truncated]';
// JSON writes a control character as 6 characters (\u0001), so an error
// response with an id, a message and details at their caps still fits in
// 1,048,576 characters, the response cap of a CLI from before
// MAX_RPC_RESPONSE_CHARS.
invariant(
  6 * (MAX_RPC_REQUEST_ID_CHARS + MAX_RPC_ERROR_MESSAGE_CHARS) +
    MAX_RPC_ERROR_DETAILS_CHARS +
    1_024 <
    1_048_576,
  'RPC error message and details caps must fit in one RPC response.',
);

const SOCKET_LIVENESS_PROBE_TIMEOUT_MS = 1_000;
const UNKNOWN_REQUEST_ID = 'unknown';

/**
 * Per-request context passed to RPC method handlers.
 *
 * `signal` aborts when the client socket closes, indicating the caller is no
 * longer waiting for a response.
 */
export interface MethodContext {
  readonly signal: AbortSignal;
}

export type MethodHandler = (
  params: unknown,
  context: MethodContext,
) => Promise<unknown>;

function isKnownRpcMethod(method: string): method is RpcMethod {
  return Object.hasOwn(RpcMethodSchemas, method);
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return fallback;
}

async function socketPathExists(socketPath: string): Promise<boolean> {
  try {
    await stat(socketPath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function probeSocketLiveness(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const scope = new ResourceScope();
    const probe = net.connect({ path: socketPath });
    const settlers = createResourceScopedSettlers(scope, resolve, reject);

    scope.add('rpc liveness probe socket', () => {
      probe.destroy();
    });
    const timeoutHandle = setTimeout(() => {
      // If connect neither succeeds nor fails promptly, treat the socket path as
      // stale rather than blocking host startup indefinitely.
      settlers.resolve(false);
    }, SOCKET_LIVENESS_PROBE_TIMEOUT_MS);
    scope.add('rpc liveness probe timeout', () => {
      clearTimeout(timeoutHandle);
    });

    probe.once('connect', () => {
      settlers.resolve(true);
    });

    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        settlers.resolve(false);
        return;
      }

      settlers.reject(error);
    });
  });
}

async function unlinkIfPresent(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

function extractRequestId(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'id' in value) {
    const id = value.id;

    if (
      typeof id === 'string' &&
      id.length > 0 &&
      id.length <= MAX_RPC_REQUEST_ID_CHARS
    ) {
      return id;
    }
  }

  return UNKNOWN_REQUEST_ID;
}

function requestIdFromLine(line: string): string {
  try {
    return extractRequestId(JSON.parse(line) as unknown);
  } catch {
    return UNKNOWN_REQUEST_ID;
  }
}

function sendableMessage(message: string): string {
  if (message.length <= MAX_RPC_ERROR_MESSAGE_CHARS) {
    return message;
  }
  let end = MAX_RPC_ERROR_MESSAGE_CHARS - TRUNCATED_MESSAGE_SUFFIX.length;
  const lastKept = message.charCodeAt(end - 1);
  // Do not keep the first half of a surrogate pair without its second half.
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) {
    end -= 1;
  }
  return `${message.slice(0, end)}${TRUNCATED_MESSAGE_SUFFIX}`;
}

function buildErrorResponse(id: string, message: string): RpcResponse {
  const response = {
    id,
    ok: false,
    error: {
      code: ERROR_CODES.RPC_ERROR,
      message: sendableMessage(message),
    },
  } as const;
  const responseResult = RpcResponseSchema.safeParse(response);
  invariant(
    responseResult.success,
    'RPC error response must satisfy RpcResponseSchema.',
  );

  return responseResult.data;
}

function sendableDetails(
  details: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (Object.keys(details).length === 0) {
    return undefined;
  }
  let serialized: unknown;
  try {
    serialized = JSON.stringify(details);
  } catch {
    return undefined;
  }
  // A toJSON can turn the details into undefined, a string or an array.
  if (
    typeof serialized !== 'string' ||
    serialized.length > MAX_RPC_ERROR_DETAILS_CHARS
  ) {
    return undefined;
  }
  const parsed = JSON.parse(serialized) as unknown;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function buildCliErrorResponse(id: string, error: CliError): RpcResponse {
  const details = sendableDetails(error.details);
  const response = {
    id,
    ok: false,
    error: {
      code: error.code,
      message: sendableMessage(error.message),
      ...(details === undefined ? {} : { details }),
    },
  } as const;
  const responseResult = RpcResponseSchema.safeParse(response);
  invariant(
    responseResult.success,
    'RPC CliError response must satisfy RpcResponseSchema.',
  );

  return responseResult.data;
}

function buildSuccessResponse(id: string, result: unknown): RpcResponse {
  const response = {
    id,
    ok: true,
    result,
  } as const;
  const responseResult = RpcResponseSchema.safeParse(response);
  invariant(
    responseResult.success,
    'RPC success response must satisfy RpcResponseSchema.',
  );

  return responseResult.data;
}

export class RpcServer {
  private readonly socketPath: string;
  private readonly handlers: Readonly<Record<string, MethodHandler>>;
  private server: net.Server | null = null;
  private closePromise: Promise<void> | null = null;

  public constructor(
    socketPath: string,
    handlers: Record<string, MethodHandler>,
  ) {
    invariant(socketPath.length > 0, 'RPC socket path must not be empty.');

    this.socketPath = socketPath;
    this.handlers = handlers;
  }

  public async listen(): Promise<void> {
    invariant(this.server === null, 'RPC server is already listening.');

    await this.removeStaleSocketIfNeeded();
    invariant(
      this.socketPath.length <= MAX_UNIX_SOCKET_PATH,
      `Socket path exceeds Unix domain socket limit of ${String(MAX_UNIX_SOCKET_PATH)} bytes: ${this.socketPath} (${String(this.socketPath.length)} bytes)`,
    );
    invariant(
      !(await socketPathExists(this.socketPath)),
      `RPC socket path must not exist before listen(): ${this.socketPath}`,
    );

    const server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    server.on('error', () => {
      // Keep server errors from becoming unhandled events after listen().
    });

    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          reject(error);
        };

        server.once('error', onError);
        server.listen(this.socketPath, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }

    await chmod(this.socketPath, 0o600);
  }

  public async close(): Promise<void> {
    if (this.closePromise !== null) {
      await this.closePromise;
      return;
    }

    const server = this.server;
    this.server = null;

    if (server === null) {
      await unlinkIfPresent(this.socketPath);
      return;
    }

    this.closePromise = (async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      await unlinkIfPresent(this.socketPath);
    })();

    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  private async removeStaleSocketIfNeeded(): Promise<void> {
    if (!(await socketPathExists(this.socketPath))) {
      return;
    }

    const socketIsLive = await probeSocketLiveness(this.socketPath);
    invariant(
      !socketIsLive,
      `RPC socket already has a live listener: ${this.socketPath}`,
    );

    await unlinkIfPresent(this.socketPath);
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding('utf8');

    let buffer = '';
    let handled = false;

    socket.on('error', () => {
      socket.destroy();
    });

    socket.on('data', (chunk: string) => {
      if (handled) {
        return;
      }

      if (buffer.length + chunk.length > MAX_RPC_REQUEST_CHARS) {
        handled = true;
        this.sendResponse(
          socket,
          buildErrorResponse(
            extractRequestId(undefined),
            'RPC request exceeds maximum buffer size.',
          ),
        );
        return;
      }

      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');

      if (newlineIndex < 0) {
        return;
      }

      handled = true;
      const line = buffer.slice(0, newlineIndex);
      void this.processRequestLine(socket, line).catch((error: unknown) => {
        // An unhandled rejection would end the host and its session, so a
        // failure to build or send the response gets a plain RPC_ERROR.
        console.error('RPC request handling failed unexpectedly:', error);
        this.sendResponse(
          socket,
          buildErrorResponse(
            requestIdFromLine(line),
            'RPC request handling failed unexpectedly.',
          ),
        );
      });
    });

    socket.on('end', () => {
      if (handled) {
        return;
      }

      handled = true;
      this.sendResponse(
        socket,
        buildErrorResponse(
          UNKNOWN_REQUEST_ID,
          buffer.length === 0
            ? 'RPC request ended before any data was received.'
            : 'RPC request was not newline-delimited.',
        ),
      );
    });
  }

  private async processRequestLine(
    socket: net.Socket,
    line: string,
  ): Promise<void> {
    let rawRequest: unknown;

    try {
      rawRequest = JSON.parse(line) as unknown;
    } catch (error) {
      this.sendResponse(
        socket,
        buildErrorResponse(
          UNKNOWN_REQUEST_ID,
          toErrorMessage(error, 'Failed to parse RPC request JSON.'),
        ),
      );
      return;
    }

    const requestResult = RpcRequestSchema.safeParse(rawRequest);

    if (!requestResult.success) {
      this.sendResponse(
        socket,
        buildErrorResponse(
          extractRequestId(rawRequest),
          requestResult.error.message,
        ),
      );
      return;
    }

    const request = requestResult.data;
    const params = request.params ?? {};

    if (
      !Object.hasOwn(this.handlers, request.method) ||
      !isKnownRpcMethod(request.method)
    ) {
      this.sendResponse(
        socket,
        buildErrorResponse(request.id, `Unsupported method: ${request.method}`),
      );
      return;
    }

    const handler = this.handlers[request.method];
    invariant(
      typeof handler === 'function',
      `RPC handler for method "${request.method}" must be a function.`,
    );

    const paramsResult =
      RpcMethodSchemas[request.method].params.safeParse(params);

    if (!paramsResult.success) {
      this.sendResponse(
        socket,
        buildErrorResponse(request.id, paramsResult.error.message),
      );
      return;
    }

    const requestScope = new ResourceScope();
    const requestAbortController = new AbortController();
    const abortRequest = (): void => {
      requestAbortController.abort(
        makeAbortReason('RPC client socket closed.'),
      );
    };
    socket.once('close', abortRequest);
    requestScope.add('rpc request close listener', () => {
      socket.off('close', abortRequest);
    });

    try {
      const result = await handler(paramsResult.data, {
        signal: requestAbortController.signal,
      });
      if (requestAbortController.signal.aborted) {
        return;
      }

      const resultResult =
        RpcMethodSchemas[request.method].result.safeParse(result);

      if (!resultResult.success) {
        this.sendResponse(
          socket,
          buildErrorResponse(request.id, resultResult.error.message),
        );
        return;
      }

      this.sendResponse(
        socket,
        buildSuccessResponse(request.id, resultResult.data),
      );
    } catch (error) {
      if (requestAbortController.signal.aborted) {
        return;
      }

      this.sendResponse(
        socket,
        error instanceof CliError
          ? buildCliErrorResponse(request.id, error)
          : buildErrorResponse(
              request.id,
              toErrorMessage(
                error,
                `RPC handler failed for method "${request.method}".`,
              ),
            ),
      );
    } finally {
      try {
        await requestScope.close();
      } catch (error) {
        console.debug('RPC request ResourceScope cleanup failed:', error);
      }
    }
  }

  private sendResponse(socket: net.Socket, response: RpcResponse): void {
    const message = `${JSON.stringify(response)}\n`;
    if (message.length <= MAX_RPC_RESPONSE_CHARS) {
      socket.end(message);
      return;
    }

    // An error response stays under 1,048,576 characters (see the invariant
    // at the top of this file), so only a success response gets here.
    invariant(
      response.ok,
      'Only an RPC success response can exceed the response cap.',
    );
    const refusal = buildCliErrorResponse(
      response.id,
      makeCliError(ERROR_CODES.PROTOCOL_ERROR, {
        message: `RPC response takes ${String(message.length)} characters, over the ${String(MAX_RPC_RESPONSE_CHARS)}-character limit.`,
        details: {
          responseChars: message.length,
          maxResponseChars: MAX_RPC_RESPONSE_CHARS,
        },
      }),
    );
    socket.end(`${JSON.stringify(refusal)}\n`);
  }
}
