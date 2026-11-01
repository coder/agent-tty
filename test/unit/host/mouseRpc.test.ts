import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MouseInputEvent } from '@coder/libghostty-vt-node';
import type { MouseRequest } from '../../../src/host/mouseRpc.js';
import type { LibghosttyVtNativeModule } from '../../../src/renderer/libghosttyVt/backend.js';
import type { LibghosttyVtProbe } from '../../../src/renderer/readiness.js';
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
const BREAKS_REPLAY = 'breaks-replay';
const MOUSE_CAPABLE: LibghosttyVtProbe = {
  available: true,
  mouseInputAvailable: true,
};
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
          if (text === BREAKS_REPLAY) {
            throw new RangeError('native feed rejected the replay');
          }
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
  let backendsCreated: number;
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

  function createHandler(
    options: { onPtyWrite?: () => void; probe?: LibghosttyVtProbe } = {},
  ) {
    return createMouseRpcHandler({
      rendererManager,
      profile,
      probeLibghosttyVt: () => Promise.resolve(options.probe ?? MOUSE_CAPABLE),
      loadReplayInput,
      assertCommandable: () => undefined,
      writePty: (data) => {
        ptyWrites.push(data.toString('latin1'));
        options.onPtyWrite?.();
      },
      appendMouseEvent: (payload) => eventLog.append('input_mouse', payload),
    });
  }

  beforeEach(async () => {
    // oxfmt-ignore
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-rpc-')));
    eventLog = await EventLog.open(join(tempDir, 'events.jsonl'));
    ptyWrites = [];
    backendsCreated = 0;
    const nativeModule = createTrackingNativeModule();
    rendererManager = new HostRendererManager({
      sessionId: SESSION_ID,
      sessionDir: tempDir,
      backendFactory: (_rendererName, sessionId, backendProfile) => {
        backendsCreated += 1;
        return new LibghosttyVtBackend(sessionId, backendProfile, {
          loadNative: () => Promise.resolve(nativeModule),
          logger: createLogger('info', () => undefined),
        });
      },
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

  it('rejects a cell outside the terminal grid as invalid input without writing it', async () => {
    await eventLog.append('output', { data: ENABLE_SGR_TRACKING });
    const sendMouse = createHandler();

    await expect(
      sendMouse({ ...LEFT_PRESS, row: 24 }, 'libghostty-vt'),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('80x24 terminal grid') as unknown,
    });
    expect(ptyWrites).toEqual([]);
    expect(eventLog.getEvents().map((event) => event.type)).toEqual(['output']);
  });

  it.each([
    ['the optional package is missing', { available: false }],
    [
      'the package predates mouse encoding',
      { available: true, mouseInputAvailable: false },
    ],
  ] satisfies [string, LibghosttyVtProbe][])(
    'reports CAPABILITY_UNAVAILABLE before booting a renderer when %s',
    async (_name, probe) => {
      await eventLog.append('output', { data: ENABLE_SGR_TRACKING });
      const sendMouse = createHandler({ probe });

      await expect(
        sendMouse(LEFT_PRESS, 'libghostty-vt'),
      ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
      expect(backendsCreated).toBe(0);
      expect(ptyWrites).toEqual([]);
    },
  );

  it('does not report a replay failure as invalid input', async () => {
    await eventLog.append('output', { data: BREAKS_REPLAY });
    const sendMouse = createHandler();

    await expect(sendMouse(LEFT_PRESS, 'libghostty-vt')).rejects.toThrow(
      new RangeError('native feed rejected the replay'),
    );
  });

  it('logs mouse input in the order its bytes reach the PTY', async () => {
    await eventLog.append('output', { data: ENABLE_SGR_TRACKING });
    const ptyOrder: string[] = [];
    const sendMouse = createHandler({
      onPtyWrite: () => {
        ptyOrder.push('input_mouse');
        // Another input handler resumes as soon as this request yields, and
        // writes and logs its bytes in one step the way `type` does.
        queueMicrotask(() => {
          ptyOrder.push('input_text');
          void eventLog.append('input_text', { data: 'x' });
        });
      },
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
