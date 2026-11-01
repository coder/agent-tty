import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MouseInputEvent } from '@coder/libghostty-vt-node';
import type { MouseRequest } from '../../../src/host/mouseRpc.js';
import type { LibghosttyVtNativeModule } from '../../../src/renderer/libghosttyVt/backend.js';
import type { ReplayInput } from '../../../src/renderer/types.js';

import { EventLog } from '../../../src/host/eventLog.js';
import { createMouseRpcHandler } from '../../../src/host/mouseRpc.js';
import { HostRendererManager } from '../../../src/host/renderer.js';
import { LibghosttyVtBackend } from '../../../src/renderer/libghosttyVt/backend.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';
import { createLogger } from '../../../src/util/logger.js';

const SESSION_ID = 'session-01';
const ENABLE_SGR_TRACKING = '\u001b[?1000h\u001b[?1006h';
const DISABLE_TRACKING = '\u001b[?1000l';
const LEFT_PRESS: MouseRequest = {
  action: 'press',
  button: 'left',
  row: 1,
  col: 2,
  modifiers: {},
};

// A native terminal that knows only whether the child enabled mouse tracking.
function createTrackingNativeModule(): LibghosttyVtNativeModule {
  return {
    createTerminal: (options) => {
      let cols = options.cols;
      let rows = options.rows;
      let tracking = false;
      return {
        feed: (data) => {
          const text = String(data);
          if (text.includes('\u001b[?1000h')) {
            tracking = true;
          }
          if (text.includes(DISABLE_TRACKING)) {
            tracking = false;
          }
        },
        resize: (nextCols, nextRows) => {
          cols = nextCols;
          rows = nextRows;
        },
        snapshot: () => ({
          cols,
          rows,
          cursorRow: 0,
          cursorCol: 0,
          cursorVisible: true,
          isAltScreen: false,
          visibleLines: [],
        }),
        getVisibleText: () => '',
        encodeMouse: (event: MouseInputEvent) =>
          tracking
            ? Buffer.from(
                `\u001b[<0;${String(event.x + 1)};${String(event.y + 1)}M`,
              )
            : Buffer.alloc(0),
        dispose: () => undefined,
      };
    },
  };
}

describe('mouse RPC handler', () => {
  let tempDir = '';
  let eventLog: EventLog;
  let rendererManager: HostRendererManager;
  let ptyWrites: string[];

  const profile = resolveProfile('reference-dark');

  const loadReplayInput = (): ReplayInput | null => {
    const events = eventLog.getEvents();
    const last = events.at(-1);
    return last === undefined
      ? null
      : {
          sessionId: SESSION_ID,
          initialCols: 80,
          initialRows: 24,
          events: [...events],
          targetSeq: last.seq,
        };
  };

  function createHandler(onPtyWrite?: () => void) {
    return createMouseRpcHandler({
      rendererManager,
      profile,
      loadReplayInput,
      assertCommandable: () => undefined,
      writePty: (data) => {
        ptyWrites.push(data.toString('latin1'));
        onPtyWrite?.();
      },
      appendMouseEvent: (payload) => eventLog.append('input_mouse', payload),
    });
  }

  beforeEach(async () => {
    // oxfmt-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-rpc-')));
    eventLog = await EventLog.open(join(tempDir, 'events.jsonl'));
    ptyWrites = [];
    const nativeModule = createTrackingNativeModule();
    rendererManager = new HostRendererManager({
      sessionId: SESSION_ID,
      sessionDir: tempDir,
      backendFactory: (_rendererName, sessionId, backendProfile) =>
        new LibghosttyVtBackend(sessionId, backendProfile, {
          loadNative: () => Promise.resolve(nativeModule),
          logger: createLogger('info', () => undefined),
        }),
    });
  });

  afterEach(async () => {
    await rendererManager.dispose();
    await eventLog.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('encodes with the mouse mode the child set while the request waited for the renderer lock', async () => {
    await eventLog.append('output', { data: ENABLE_SGR_TRACKING });
    const sendMouse = createHandler();
    const lockHolder = Promise.withResolvers<undefined>();
    const otherRendererWork = rendererManager.withBackend(
      'libghostty-vt',
      profile,
      loadReplayInput(),
      () => lockHolder.promise,
    );

    const pending = sendMouse(LEFT_PRESS, 'libghostty-vt');
    await eventLog.append('output', { data: DISABLE_TRACKING });
    lockHolder.resolve(undefined);
    await otherRendererWork;

    await expect(pending).resolves.toMatchObject({
      reported: false,
      bytesWritten: 0,
    });
    expect(ptyWrites).toEqual([]);
  });

  it('logs mouse input in the order its bytes reach the PTY', async () => {
    await eventLog.append('output', { data: ENABLE_SGR_TRACKING });
    const ptyOrder: string[] = [];
    const sendMouse = createHandler(() => {
      ptyOrder.push('input_mouse');
      // Another input handler resumes as soon as this request yields, and
      // writes and logs its bytes in one step the way `type` does.
      queueMicrotask(() => {
        ptyOrder.push('input_text');
        void eventLog.append('input_text', { data: 'x' });
      });
    });

    await expect(sendMouse(LEFT_PRESS, 'libghostty-vt')).resolves.toMatchObject(
      { reported: true },
    );

    expect(
      eventLog
        .getEvents()
        .filter((event) => event.type.startsWith('input_'))
        .map((event) => event.type),
    ).toEqual(ptyOrder);
    expect(ptyOrder).toEqual(['input_mouse', 'input_text']);
  });
});
