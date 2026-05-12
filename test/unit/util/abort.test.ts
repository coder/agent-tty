import { describe, expect, it, vi } from 'vitest';

import {
  addAbortListener,
  createResourceScopedSettlers,
  makeAbortError,
  throwIfAborted,
  waitForScopedOperation,
} from '../../../src/util/abort.js';
import {
  ResourceScope,
  ResourceScopeCloseError,
} from '../../../src/util/resourceScope.js';

describe('abort utilities', () => {
  it('creates AbortError instances from missing or string abort reasons', () => {
    const defaultError = makeAbortError();
    expect(defaultError.name).toBe('AbortError');
    expect(defaultError.message).toBe('Operation aborted.');

    const controller = new AbortController();
    controller.abort('client disconnected');

    const reasonError = makeAbortError(controller.signal);
    expect(reasonError.name).toBe('AbortError');
    expect(reasonError.message).toBe('client disconnected');
  });

  it('forwards Error abort reasons without wrapping them', () => {
    const controller = new AbortController();
    const reason = new Error('stop now');
    controller.abort(reason);

    expect(makeAbortError(controller.signal)).toBe(reason);
    expect(() => throwIfAborted(controller.signal)).toThrow(reason);
  });

  it('registers abort listeners with ResourceScope cleanup', async () => {
    const scope = new ResourceScope();
    const controller = new AbortController();
    const listener = vi.fn();

    addAbortListener(scope, 'test abort listener', controller.signal, listener);
    await scope.close();
    controller.abort();

    expect(listener).not.toHaveBeenCalled();
  });

  it('asserts when registering a listener on an already aborted signal', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      addAbortListener(
        new ResourceScope(),
        'late listener',
        controller.signal,
        () => undefined,
      ),
    ).toThrow(/before signal aborts/u);
  });

  it('settles only once and closes the ResourceScope before resolving', async () => {
    const scope = new ResourceScope();
    const releases: string[] = [];
    scope.add('release', () => {
      releases.push('closed');
    });
    const { promise, reject, resolve } = Promise.withResolvers<string>();
    const settlers = createResourceScopedSettlers(scope, resolve, reject);

    settlers.resolve('ok');
    settlers.reject(new Error('late'));

    await expect(promise).resolves.toBe('ok');
    expect(releases).toEqual(['closed']);
  });

  it('preserves the original rejection when scope close also fails', async () => {
    const scope = new ResourceScope();
    const closeFailure = new Error('close failed');
    const originalFailure = new Error('operation failed');
    scope.add('failing release', () => {
      throw closeFailure;
    });
    const { promise, reject, resolve } = Promise.withResolvers<string>();
    const settlers = createResourceScopedSettlers(scope, resolve, reject);

    settlers.reject(originalFailure);

    await expect(promise).rejects.toMatchObject({
      errors: [originalFailure, expect.any(ResourceScopeCloseError)],
    });
  });

  it('waitForScopedOperation resolves timeout results and clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string>(() => undefined);
      const promise = waitForScopedOperation({
        operationName: 'test operation',
        operation: never,
        scope: new ResourceScope(),
        timeoutMs: 10,
        timeoutResult: () => 'timed out',
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(promise).resolves.toBe('timed out');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForScopedOperation aborts, runs onAbort, and clears the timeout', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onAbort = vi.fn();
      const reason = new Error('request closed');
      const never = new Promise<string>(() => undefined);
      const promise = waitForScopedOperation({
        operationName: 'test operation',
        operation: never,
        scope: new ResourceScope(),
        signal: controller.signal,
        timeoutMs: 100,
        timeoutResult: () => 'timed out',
        onAbort,
      });

      controller.abort(reason);

      await expect(promise).rejects.toThrow(reason);
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
