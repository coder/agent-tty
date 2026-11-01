import type { MouseInput, MouseResult } from '../protocol/messages.js';
import type { InputMouseEventPayload } from '../protocol/schemas.js';
import type {
  MouseEncodingBackend,
  MouseEncodingInput,
} from '../renderer/backend.js';
import type { RendererName } from '../renderer/names.js';
import type { LibghosttyVtProbe } from '../renderer/readiness.js';
import type { RenderProfileConfig, ReplayInput } from '../renderer/types.js';
import type { HostRendererManager } from './renderer.js';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { supportsMouseEncoding } from '../renderer/backend.js';
import { LIBGHOSTTY_VT_PACKAGE } from '../renderer/readiness.js';
import { invariant } from '../util/assert.js';
import { prepareHeldMouseButtons, type HeldMouseButton } from './mouseInput.js';

export interface MouseRpcDependencies {
  readonly rendererManager: Pick<HostRendererManager, 'withBackend'>;
  readonly profile: RenderProfileConfig;
  readonly probeLibghosttyVt: () => Promise<LibghosttyVtProbe>;
  readonly loadReplayInput: () => ReplayInput | null;
  readonly assertCommandable: () => void;
  readonly writePty: (data: Buffer) => void;
  readonly appendMouseEvent: (
    payload: InputMouseEventPayload,
  ) => Promise<number>;
}

// The native encoder throws RangeError or TypeError for values it cannot
// encode. Only those, and only from the encoder, are the caller's fault.
function encodeMouse(
  backend: MouseEncodingBackend,
  input: MouseEncodingInput,
): Buffer {
  try {
    return backend.encodeMouse(input);
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Build the host's `mouse` RPC: encode one semantic mouse action with the
 * modes the child negotiated, write it to the PTY, and record it. The handler
 * owns the held-button state across requests.
 */
export function createMouseRpcHandler(
  deps: MouseRpcDependencies,
): (request: MouseInput, rendererName: RendererName) => Promise<MouseResult> {
  let heldMouseButtons: ReadonlySet<HeldMouseButton> = new Set();

  return async (request, rendererName) => {
    const { action, button, row, col, cellWidth, cellHeight, modifiers } =
      request;
    const normalizedModifiers = {
      shift: modifiers.shift ?? false,
      alt: modifiers.alt ?? false,
      ctrl: modifiers.ctrl ?? false,
    };
    if (rendererName !== 'libghostty-vt') {
      throw makeCliError(ERROR_CODES.CAPABILITY_UNAVAILABLE, {
        message: `Renderer ${rendererName} cannot encode mouse input. Use libghostty-vt.`,
      });
    }
    const probe = await deps.probeLibghosttyVt();
    if (probe.mouseInputAvailable !== true) {
      throw makeCliError(ERROR_CODES.CAPABILITY_UNAVAILABLE, {
        message: `Mouse input needs the optional dependency ${LIBGHOSTTY_VT_PACKAGE} with mouse encoding, which this install does not provide. Reinstall agent-tty on a supported platform, then run \`agent-tty doctor\` to check the mouse-input capability.`,
        details: {
          rendererBackend: rendererName,
          ...(probe.reason === undefined ? {} : { reason: probe.reason }),
          ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        },
      });
    }
    const replayInput = deps.loadReplayInput();

    const { encoded, seq } = await deps.rendererManager.withBackend(
      rendererName,
      deps.profile,
      replayInput,
      async (backend) => {
        invariant(
          supportsMouseEncoding(backend),
          'the libghostty-vt backend must encode mouse input',
        );
        // Output the child printed while this request waited for the lock,
        // or while the backend booted or replayed, can change its mouse
        // modes. Replay until the backend holds the whole event log.
        let appliedSeq = replayInput?.targetSeq ?? -1;
        let latest = deps.loadReplayInput();
        while (latest !== null && latest.targetSeq > appliedSeq) {
          await backend.replayTo(latest);
          appliedSeq = latest.targetSeq;
          latest = deps.loadReplayInput();
        }

        // No await from here through appendMouseEvent, which reserves the
        // seq synchronously, so no output can make the bytes stale and no
        // other input can reach the PTY or the log in between. The lock
        // also orders held-button transitions across requests.
        const transition = prepareHeldMouseButtons(heldMouseButtons, {
          action,
          ...(button === undefined ? {} : { button }),
        });
        const encoded = encodeMouse(backend, {
          action,
          ...(button === undefined
            ? action === 'move' && transition.dragButton !== undefined
              ? { button: transition.dragButton }
              : {}
            : { button }),
          row,
          col,
          ...(cellWidth === undefined ? {} : { cellWidth }),
          ...(cellHeight === undefined ? {} : { cellHeight }),
          modifiers: normalizedModifiers,
          anyButtonPressed: transition.anyButtonPressed,
        });
        deps.assertCommandable();
        if (encoded.length > 0) {
          deps.writePty(encoded);
        }
        const seq = deps.appendMouseEvent({
          action,
          ...(button === undefined ? {} : { button }),
          row,
          col,
          modifiers: normalizedModifiers,
          rendererBackend: backend.rendererBackend,
          ...(cellWidth === undefined ? {} : { cellWidth }),
          ...(cellHeight === undefined ? {} : { cellHeight }),
          dataBase64: encoded.toString('base64'),
        });
        heldMouseButtons = transition.nextHeld;
        return { encoded, seq };
      },
    );

    return {
      reported: encoded.length > 0,
      bytesWritten: encoded.length,
      seq: await seq,
    };
  };
}
