import type { MouseParams, MouseResult } from '../protocol/messages.js';
import type { InputMouseEventPayload } from '../protocol/schemas.js';
import type { RendererName } from '../renderer/names.js';
import type { RenderProfileConfig, ReplayInput } from '../renderer/types.js';
import type { HostRendererManager } from './renderer.js';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { supportsMouseEncoding } from '../renderer/backend.js';
import { prepareHeldMouseButtons, type HeldMouseButton } from './mouseInput.js';

export type MouseRequest = Omit<MouseParams, 'rendererName'>;

export interface MouseRpcDependencies {
  readonly rendererManager: Pick<HostRendererManager, 'withBackend'>;
  readonly profile: RenderProfileConfig;
  readonly loadReplayInput: () => ReplayInput | null;
  readonly assertCommandable: () => void;
  readonly writePty: (data: Buffer) => void;
  readonly appendMouseEvent: (
    payload: InputMouseEventPayload,
  ) => Promise<number>;
}

/**
 * Build the host's `mouse` RPC: encode one semantic mouse action with the
 * modes the child negotiated, write it to the PTY, and record it. The handler
 * owns the held-button state across requests.
 */
export function createMouseRpcHandler(
  deps: MouseRpcDependencies,
): (request: MouseRequest, rendererName: RendererName) => Promise<MouseResult> {
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
    const replayInput = deps.loadReplayInput();

    let encoded: Buffer;
    let rendererBackend: string;
    try {
      ({ encoded, rendererBackend } = await deps.rendererManager.withBackend(
        rendererName,
        deps.profile,
        replayInput,
        (backend) => {
          if (!supportsMouseEncoding(backend)) {
            throw makeCliError(ERROR_CODES.CAPABILITY_UNAVAILABLE, {
              message: `Renderer ${backend.rendererBackend} cannot encode mouse input. Use libghostty-vt.`,
              details: { rendererBackend: backend.rendererBackend },
            });
          }
          // The renderer lock also serializes held-button transitions. A
          // second request can arrive while the first backend is booting.
          const transition = prepareHeldMouseButtons(heldMouseButtons, {
            action,
            ...(button === undefined ? {} : { button }),
          });
          const encoded = backend.encodeMouse({
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
          heldMouseButtons = transition.nextHeld;
          return {
            encoded,
            rendererBackend: backend.rendererBackend,
          };
        },
      ));
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw makeCliError(ERROR_CODES.INVALID_INPUT, {
          message: error.message,
          cause: error,
        });
      }
      if (
        error instanceof Error &&
        error.message.includes('terminal.encodeMouse is required')
      ) {
        throw makeCliError(ERROR_CODES.CAPABILITY_UNAVAILABLE, {
          message: error.message,
          details: { rendererBackend: rendererName },
          cause: error,
        });
      }
      throw error;
    }

    const seq = await deps.appendMouseEvent({
      action,
      ...(button === undefined ? {} : { button }),
      row,
      col,
      modifiers: normalizedModifiers,
      rendererBackend,
      ...(cellWidth === undefined ? {} : { cellWidth }),
      ...(cellHeight === undefined ? {} : { cellHeight }),
      dataBase64: encoded.toString('base64'),
    });
    return {
      reported: encoded.length > 0,
      bytesWritten: encoded.length,
      seq,
    };
  };
}
