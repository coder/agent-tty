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
    let seq: Promise<number>;
    try {
      ({ encoded, seq } = await deps.rendererManager.withBackend(
        rendererName,
        deps.profile,
        replayInput,
        async (backend) => {
          if (!supportsMouseEncoding(backend)) {
            throw makeCliError(ERROR_CODES.CAPABILITY_UNAVAILABLE, {
              message: `Renderer ${backend.rendererBackend} cannot encode mouse input. Use libghostty-vt.`,
              details: { rendererBackend: backend.rendererBackend },
            });
          }
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

    return {
      reported: encoded.length > 0,
      bytesWritten: encoded.length,
      seq: await seq,
    };
  };
}
