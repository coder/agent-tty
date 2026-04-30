import { describe, expect, it } from 'vitest';

import { KeyedSerializer } from '../../../src/util/keyedSerializer.js';

describe('KeyedSerializer', () => {
  it('returns the operation result for a single same-key call', async () => {
    const serializer = new KeyedSerializer<string>();

    const result = await serializer.run('session-1', () => Promise.resolve(42));

    expect(result).toBe(42);
  });

  it('runs same-key operations sequentially in submission order', async () => {
    const serializer = new KeyedSerializer<string>();
    const events: string[] = [];

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const first = serializer.run('session-1', async () => {
      events.push('first-start');
      await firstGate;
      events.push('first-end');
    });
    const second = serializer.run('session-1', () => {
      events.push('second-start');
      events.push('second-end');
      return Promise.resolve();
    });

    // Wait a microtask tick so any non-serialized impl would interleave.
    await Promise.resolve();
    expect(events).toEqual(['first-start']);

    resolveFirst();
    await Promise.all([first, second]);

    expect(events).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
  });

  it('allows different keys to run concurrently', async () => {
    const serializer = new KeyedSerializer<string>();
    const events: string[] = [];

    let resolveA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    const opA = serializer.run('session-a', async () => {
      events.push('a-start');
      await gateA;
      events.push('a-end');
    });
    const opB = serializer.run('session-b', () => {
      events.push('b-start');
      events.push('b-end');
      return Promise.resolve();
    });

    // session-b can complete while session-a is still gated.
    await opB;
    expect(events).toEqual(['a-start', 'b-start', 'b-end']);

    resolveA();
    await opA;
    expect(events).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  it('propagates the operation rejection to the caller', async () => {
    const serializer = new KeyedSerializer<string>();
    const error = new Error('boom');

    await expect(
      serializer.run('session-1', () => Promise.reject(error)),
    ).rejects.toBe(error);
  });

  it('cascades a predecessor rejection to a queued same-key operation while the chain drains', async () => {
    const serializer = new KeyedSerializer<string>();
    const upstream = new Error('upstream');
    let secondRan = false;

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializer.run('session-1', async () => {
      await firstGate;
      throw upstream;
    });
    const second = serializer.run('session-1', () => {
      secondRan = true;
      return Promise.resolve();
    });

    releaseFirst();

    await expect(first).rejects.toBe(upstream);
    await expect(second).rejects.toBe(upstream);
    expect(secondRan).toBe(false);
  });

  it('starts a fresh chain for the same key after the previous chain drains, even after rejection', async () => {
    const serializer = new KeyedSerializer<string>();

    await expect(
      serializer.run('session-1', () => Promise.reject(new Error('first'))),
    ).rejects.toThrow('first');

    const result = await serializer.run('session-1', () =>
      Promise.resolve('ok'),
    );

    expect(result).toBe('ok');
  });

  it('preserves generic return types', async () => {
    const serializer = new KeyedSerializer<string>();

    const numericResult: number = await serializer.run('session-1', () =>
      Promise.resolve(7),
    );
    const stringResult: string = await serializer.run('session-2', () =>
      Promise.resolve('hello'),
    );

    expect(numericResult).toBe(7);
    expect(stringResult).toBe('hello');
  });
});
