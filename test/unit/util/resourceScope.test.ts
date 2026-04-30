import { describe, expect, it } from 'vitest';

import {
  ResourceScope,
  ResourceScopeCloseError,
} from '../../../src/util/resourceScope.js';

describe('ResourceScope', () => {
  it('runs the registered release callback when close() is called', async () => {
    const scope = new ResourceScope();
    let released = false;

    scope.add('connection', () => {
      released = true;
    });

    await scope.close();

    expect(released).toBe(true);
  });

  it('runs releases in LIFO (reverse acquisition) order', async () => {
    const scope = new ResourceScope();
    const order: string[] = [];

    scope.add('server', () => {
      order.push('server');
    });
    scope.add('browser', () => {
      order.push('browser');
    });
    scope.add('page', () => {
      order.push('page');
    });

    await scope.close();

    expect(order).toEqual(['page', 'browser', 'server']);
  });

  it('attempts every release even when earlier releases fail and throws ResourceScopeCloseError preserving names and errors', async () => {
    const scope = new ResourceScope();
    const order: string[] = [];
    const browserError = new Error('browser close failed');
    const pageError = new Error('page close failed');

    scope.add('server', () => {
      order.push('server');
    });
    scope.add('browser', () => {
      order.push('browser');
      throw browserError;
    });
    scope.add('page', () => {
      order.push('page');
      throw pageError;
    });

    let caught: unknown;
    try {
      await scope.close();
    } catch (error) {
      caught = error;
    }

    expect(order).toEqual(['page', 'browser', 'server']);
    expect(caught).toBeInstanceOf(ResourceScopeCloseError);
    const closeError = caught as ResourceScopeCloseError;
    expect(closeError.failures).toEqual([
      { name: 'page', error: pageError },
      { name: 'browser', error: browserError },
    ]);
    expect(closeError.message).toContain('page');
    expect(closeError.message).toContain('browser');
  });

  it('returns the same close result to concurrent callers and runs each release exactly once', async () => {
    const scope = new ResourceScope();
    let releaseCount = 0;
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    scope.add('slow', async () => {
      releaseCount += 1;
      await gate;
    });

    const first = scope.close();
    const second = scope.close();
    resolveGate();

    await Promise.all([first, second]);

    expect(releaseCount).toBe(1);
  });

  it('does not re-run successful or failed releases on a later close()', async () => {
    const scope = new ResourceScope();
    const calls: string[] = [];

    scope.add('ok', () => {
      calls.push('ok');
    });
    scope.add('fail', () => {
      calls.push('fail');
      throw new Error('fail');
    });

    await expect(scope.close()).rejects.toBeInstanceOf(ResourceScopeCloseError);
    await expect(scope.close()).rejects.toBeInstanceOf(ResourceScopeCloseError);

    expect(calls).toEqual(['fail', 'ok']);
  });

  it('throws when add() is called after close()', async () => {
    const scope = new ResourceScope();
    await scope.close();

    expect(() => scope.add('late', () => undefined)).toThrow(
      /closed ResourceScope/u,
    );
  });

  it('awaits async releases sequentially', async () => {
    const scope = new ResourceScope();
    const order: string[] = [];

    scope.add('first', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('first');
    });
    scope.add('second', () => {
      order.push('second');
    });

    await scope.close();

    // LIFO order means 'second' runs first, then we await 'first' (slow).
    expect(order).toEqual(['second', 'first']);
  });

  it('asserts on invalid add() inputs', () => {
    const scope = new ResourceScope();

    expect(() => scope.add('', () => undefined)).toThrow(
      /name must be a non-empty string/u,
    );
    expect(() => scope.add('bad', undefined as unknown as () => void)).toThrow(
      /release must be a function/u,
    );
  });
});
