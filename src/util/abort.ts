import { invariant } from './assert.js';
import type { ResourceScope } from './resourceScope.js';

export interface ResourceScopedSettlers<T> {
  readonly isSettled: () => boolean;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

type TimeoutConfig<T> =
  | {
      readonly timeoutMs: number;
      readonly timeoutResult: () => T;
    }
  | {
      readonly timeoutMs?: never;
      readonly timeoutResult?: never;
    };

export type ScopedOperationOptions<T> = {
  readonly operationName: string;
  readonly operation: Promise<T>;
  readonly scope: ResourceScope;
  readonly signal?: AbortSignal | undefined;
  readonly onAbort?: () => void;
} & TimeoutConfig<T>;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function makeScopeCloseRejectionError(
  originalError: unknown,
  closeError: unknown,
): AggregateError {
  return new AggregateError(
    [toError(originalError), toError(closeError)],
    'ResourceScope close failed while rejecting operation.',
  );
}

/** Creates a specific AbortError reason to pass into `AbortController.abort()`. */
export function makeAbortReason(message: string): Error {
  invariant(message.length > 0, 'abort reason message must not be empty');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Extracts an AbortError from an observed signal, preserving `signal.reason`. */
export function makeAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(
    typeof reason === 'string' && reason.length > 0
      ? reason
      : 'Operation aborted.',
  );
  error.name = 'AbortError';
  return error;
}

/** Throws if `signal` is aborted; no-op when `signal` is undefined. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw makeAbortError(signal);
  }
}

/**
 * Registers an abort listener and removes it when `scope` closes.
 *
 * The signal must not already be aborted; callers should check
 * `signal.aborted` or call `throwIfAborted()` before registering.
 */
export function addAbortListener(
  scope: ResourceScope,
  name: string,
  signal: AbortSignal,
  listener: () => void,
): void {
  invariant(
    !signal.aborted,
    'abort listener must be registered before signal aborts',
  );
  invariant(
    typeof listener === 'function',
    'abort listener must be a function',
  );

  signal.addEventListener('abort', listener, { once: true });
  scope.add(name, () => {
    signal.removeEventListener('abort', listener);
  });
}

/**
 * Creates idempotent Promise settlers that close `scope` before resolving or
 * rejecting the outer operation. If cleanup fails while resolving, the promise
 * rejects with the cleanup error. If cleanup fails while rejecting, the original
 * operation error is preserved alongside the cleanup failure in an
 * `AggregateError`.
 */
export function createResourceScopedSettlers<T>(
  scope: ResourceScope,
  resolve: (value: T) => void,
  reject: (error: Error) => void,
): ResourceScopedSettlers<T> {
  invariant(typeof resolve === 'function', 'resolve must be a function');
  invariant(typeof reject === 'function', 'reject must be a function');

  let settled = false;

  return {
    isSettled: () => settled,
    reject: (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      void scope.close().then(
        () => {
          reject(toError(error));
        },
        (closeError: unknown) => {
          reject(makeScopeCloseRejectionError(error, closeError));
        },
      );
    },
    resolve: (value: T): void => {
      if (settled) {
        return;
      }

      settled = true;
      void scope.close().then(
        () => {
          resolve(value);
        },
        (closeError: unknown) => {
          reject(toError(closeError));
        },
      );
    },
  };
}

function runAbortCallback(onAbort: (() => void) | undefined): Error | null {
  try {
    onAbort?.();
    return null;
  } catch (error) {
    return toError(error);
  }
}

/**
 * Waits for `operation`, an optional timeout, or an optional abort signal while
 * tying all timers/listeners to `scope`. The scope closes before the returned
 * promise settles. `timeoutResult` is evaluated lazily when the timeout wins,
 * and `onAbort` runs before scope cleanup for both pre-aborted and later-aborted
 * signals.
 */
export async function waitForScopedOperation<T>(
  options: ScopedOperationOptions<T>,
): Promise<T> {
  const {
    operationName,
    operation,
    scope,
    signal,
    timeoutMs,
    timeoutResult,
    onAbort,
  } = options;
  invariant(operationName.length > 0, 'operationName must not be empty');
  if (signal?.aborted === true) {
    const abortCallbackError = runAbortCallback(onAbort);
    await scope.close();
    throw abortCallbackError ?? makeAbortError(signal);
  }

  const { promise, reject, resolve } = Promise.withResolvers<T>();
  const settlers = createResourceScopedSettlers(scope, resolve, reject);

  if (timeoutMs !== undefined) {
    const timeoutHandle = setTimeout(() => {
      settlers.resolve(timeoutResult());
    }, timeoutMs);
    scope.add(`${operationName} timeout`, () => {
      clearTimeout(timeoutHandle);
    });
  }

  if (signal !== undefined) {
    addAbortListener(scope, `${operationName} abort listener`, signal, () => {
      const abortCallbackError = runAbortCallback(onAbort);
      settlers.reject(abortCallbackError ?? makeAbortError(signal));
    });
  }

  void operation.then(settlers.resolve, settlers.reject);

  return await promise;
}
