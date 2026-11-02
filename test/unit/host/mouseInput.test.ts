import { describe, expect, it } from 'vitest';

import { prepareHeldMouseButtons } from '../../../src/host/mouseInput.js';

describe('prepareHeldMouseButtons', () => {
  it('classifies held-button transitions across press, wheel, move, and release sets', () => {
    const none = new Set<'left' | 'middle' | 'right'>();
    const pressed = prepareHeldMouseButtons(none, {
      action: 'press',
      button: 'left',
    });
    const wheelWhileHeld = prepareHeldMouseButtons(pressed.nextHeld, {
      action: 'press',
      button: 'wheel-up',
    });
    const moved = prepareHeldMouseButtons(wheelWhileHeld.nextHeld, {
      action: 'move',
    });
    const released = prepareHeldMouseButtons(moved.nextHeld, {
      action: 'release',
      button: 'left',
    });
    const wheelAlone = prepareHeldMouseButtons(released.nextHeld, {
      action: 'press',
      button: 'wheel-down',
    });

    expect([
      [...pressed.nextHeld],
      [...wheelWhileHeld.nextHeld],
      [...moved.nextHeld],
      [...released.nextHeld],
      [...wheelAlone.nextHeld],
    ]).toEqual([['left'], ['left'], ['left'], [], []]);
    expect([
      pressed.anyButtonPressed,
      wheelWhileHeld.anyButtonPressed,
      moved.anyButtonPressed,
      released.anyButtonPressed,
      wheelAlone.anyButtonPressed,
    ]).toEqual([true, true, true, false, false]);
    expect([
      pressed.dragButton,
      wheelWhileHeld.dragButton,
      moved.dragButton,
      released.dragButton,
      wheelAlone.dragButton,
    ]).toEqual(['left', 'left', 'left', undefined, undefined]);
    expect([...none]).toEqual([]);
  });

  it('uses the most recently pressed held button for multi-button drag reports', () => {
    const left = prepareHeldMouseButtons(new Set(), {
      action: 'press',
      button: 'left',
    });
    const right = prepareHeldMouseButtons(left.nextHeld, {
      action: 'press',
      button: 'right',
    });
    const leftAgain = prepareHeldMouseButtons(right.nextHeld, {
      action: 'press',
      button: 'left',
    });

    expect([...leftAgain.nextHeld]).toEqual(['right', 'left']);
    expect(leftAgain.dragButton).toBe('left');
  });

  it('classifies invalid transition inputs', () => {
    const invalid = [
      { action: 'press' },
      { action: 'release' },
      { action: 'move', button: 'left' },
      { action: 'drag', button: 'left' },
      { action: 'press', button: 'primary' },
    ];

    expect(
      invalid.map((input) => {
        try {
          prepareHeldMouseButtons(new Set(), input as never);
          return false;
        } catch {
          return true;
        }
      }),
    ).toEqual(invalid.map(() => true));
  });
});
