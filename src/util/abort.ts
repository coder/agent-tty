import { invariant } from './assert.js';
import type { ResourceScope } from './resourceScope.js';

export interface ResourceScopedSettlers<T> {
  readonly isSettled: () => boolean;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

export interface ScopedOperationOptions<T> {
  readonly operationName: string;
  readonly operation: Promise<T>;
  readonly scope: ResourceScope;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly timeoutResult?: () => T;
  readonly onAbort?: () => void;
}

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

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw makeAbortError(signal);
  }
}

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
    onAbort?.();
    await scope.close();
    throw makeAbortError(signal);
  }

  const { promise, reject, resolve } = Promise.withResolvers<T>();
  const settlers = createResourceScopedSettlers(scope, resolve, reject);

  if (timeoutMs !== undefined) {
    invariant(
      timeoutResult !== undefined,
      'timeoutResult must be provided when timeoutMs is set',
    );
    const timeoutHandle = setTimeout(() => {
      settlers.resolve(timeoutResult());
    }, timeoutMs);
    scope.add(`${operationName} timeout`, () => {
      clearTimeout(timeoutHandle);
    });
  }

  if (signal !== undefined) {
    addAbortListener(scope, `${operationName} abort listener`, signal, () => {
      onAbort?.();
      settlers.reject(makeAbortError(signal));
    });
  }

  void operation.then(settlers.resolve, settlers.reject);

  return await promise;
}
