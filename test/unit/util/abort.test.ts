import { describe, expect, it, vi } from 'vitest';

import {
  addAbortListener,
  createResourceScopedSettlers,
  makeAbortError,
  makeAbortReason,
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

  it('creates named abort reasons for internal controllers', () => {
    const error = makeAbortReason('host shutdown');

    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('host shutdown');
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

  it('rejects with the close failure when resolving cannot close the scope', async () => {
    const scope = new ResourceScope();
    const closeFailure = new Error('close failed');
    scope.add('failing release', () => {
      throw closeFailure;
    });
    const { promise, reject, resolve } = Promise.withResolvers<string>();
    const settlers = createResourceScopedSettlers(scope, resolve, reject);

    settlers.resolve('ok');

    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ResourceScopeCloseError);
    expect((caught as ResourceScopeCloseError).failures).toEqual([
      { name: 'failing release', error: closeFailure },
    ]);
  });

  it('waitForScopedOperation resolves when the operation resolves first', async () => {
    const releases: string[] = [];
    const scope = new ResourceScope();
    scope.add('release', () => {
      releases.push('closed');
    });

    await expect(
      waitForScopedOperation({
        operationName: 'test operation',
        operation: Promise.resolve('done'),
        scope,
      }),
    ).resolves.toBe('done');
    expect(releases).toEqual(['closed']);
  });

  it('waitForScopedOperation rejects when the operation rejects first', async () => {
    const releases: string[] = [];
    const failure = new Error('operation failed');
    const scope = new ResourceScope();
    scope.add('release', () => {
      releases.push('closed');
    });

    await expect(
      waitForScopedOperation({
        operationName: 'test operation',
        operation: Promise.reject(failure),
        scope,
      }),
    ).rejects.toThrow(failure);
    expect(releases).toEqual(['closed']);
  });

  it('waitForScopedOperation clears the timeout when the operation resolves first', async () => {
    vi.useFakeTimers();
    try {
      const promise = waitForScopedOperation({
        operationName: 'test operation',
        operation: Promise.resolve('done'),
        scope: new ResourceScope(),
        timeoutMs: 100,
        timeoutResult: () => 'timed out',
      });

      await expect(promise).resolves.toBe('done');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it('waitForScopedOperation handles pre-aborted signals with cleanup and onAbort', async () => {
    const controller = new AbortController();
    const reason = new Error('already closed');
    const releases: string[] = [];
    const onAbort = vi.fn();
    const scope = new ResourceScope();
    scope.add('release', () => {
      releases.push('closed');
    });
    controller.abort(reason);

    await expect(
      waitForScopedOperation({
        operationName: 'test operation',
        operation: Promise.resolve('late'),
        scope,
        signal: controller.signal,
        onAbort,
      }),
    ).rejects.toThrow(reason);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(releases).toEqual(['closed']);
  });

  it('waitForScopedOperation rejects instead of throwing from an abort callback', async () => {
    const controller = new AbortController();
    const callbackError = new Error('abort cleanup failed');
    const never = new Promise<string>(() => undefined);
    const promise = waitForScopedOperation({
      operationName: 'test operation',
      operation: never,
      scope: new ResourceScope(),
      signal: controller.signal,
      onAbort: () => {
        throw callbackError;
      },
    });

    controller.abort(new Error('request closed'));

    await expect(promise).rejects.toThrow(callbackError);
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
