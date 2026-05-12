import { invariant } from './assert.js';
import type { ResourceScope } from './resourceScope.js';

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
