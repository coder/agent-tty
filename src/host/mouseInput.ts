import type { MouseAction, MouseButton } from '../protocol/schemas.js';
import { invariant, unreachable } from '../util/assert.js';

export type HeldMouseButton = 'left' | 'middle' | 'right';

interface MouseButtonTransitionInput {
  action: MouseAction;
  button?: MouseButton;
}

interface HeldMouseButtonTransition {
  nextHeld: ReadonlySet<HeldMouseButton>;
  anyButtonPressed: boolean;
  dragButton?: HeldMouseButton;
}

const HOLDABLE_BUTTONS = new Set<MouseButton>(['left', 'middle', 'right']);
const WHEEL_BUTTONS = new Set<MouseButton>([
  'wheel-up',
  'wheel-down',
  'wheel-left',
  'wheel-right',
]);

function isHeldMouseButton(button: MouseButton): button is HeldMouseButton {
  return HOLDABLE_BUTTONS.has(button);
}

/**
 * Stage held-button state without mutating the committed host state. The host
 * adopts `nextHeld` only after mode-aware encoding succeeds.
 */
export function prepareHeldMouseButtons(
  currentHeld: ReadonlySet<HeldMouseButton>,
  input: MouseButtonTransitionInput,
): HeldMouseButtonTransition {
  invariant(currentHeld instanceof Set, 'currentHeld must be a Set');
  invariant(
    input.action === 'press' ||
      input.action === 'release' ||
      input.action === 'move',
    'mouse action must be press, release, or move',
  );
  invariant(
    input.button === undefined ||
      HOLDABLE_BUTTONS.has(input.button) ||
      WHEEL_BUTTONS.has(input.button),
    'mouse button is invalid',
  );

  const nextHeld = new Set(currentHeld);
  switch (input.action) {
    case 'press':
      invariant(input.button !== undefined, 'press requires a mouse button');
      if (isHeldMouseButton(input.button)) {
        // Reinsert so Set iteration order retains the most recently pressed
        // button for native drag reports when more than one is held.
        nextHeld.delete(input.button);
        nextHeld.add(input.button);
      }
      break;
    case 'release':
      invariant(input.button !== undefined, 'release requires a mouse button');
      invariant(
        isHeldMouseButton(input.button),
        'wheel buttons do not have release transitions',
      );
      nextHeld.delete(input.button);
      break;
    case 'move':
      invariant(input.button === undefined, 'move must not specify a button');
      break;
    default:
      unreachable(input.action, 'unsupported mouse action');
  }

  const dragButton = [...nextHeld].at(-1);
  return {
    nextHeld,
    anyButtonPressed: nextHeld.size > 0,
    ...(dragButton === undefined ? {} : { dragButton }),
  };
}
