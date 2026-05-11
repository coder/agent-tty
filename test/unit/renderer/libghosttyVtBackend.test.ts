import { describe, expect, it, vi } from 'vitest';

import { LibghosttyVtBackend } from '../../../src/renderer/libghosttyVt/backend.js';
import type { LibghosttyVtNativeModule } from '../../../src/renderer/libghosttyVt/backend.js';
import type {
  RenderProfileConfig,
  ReplayInput,
} from '../../../src/renderer/types.js';
import { createLogger } from '../../../src/util/logger.js';

import { createFakeBackend } from '../../helpers/fakeBackend.js';

function createProfile(): RenderProfileConfig {
  return {
    name: 'reference-dark',
    theme: 'dark',
    fontFamily: 'monospace',
    fontSize: 14,
    cursorStyle: 'block',
    backgroundColor: '#000000',
    foregroundColor: '#ffffff',
  };
}

function createReplayInput(overrides: Partial<ReplayInput> = {}): ReplayInput {
  return {
    sessionId: 'session-01',
    initialCols: 10,
    initialRows: 4,
    targetSeq: 2,
    events: [
      {
        seq: 0,
        ts: '2026-03-20T12:00:00.000Z',
        type: 'output',
        payload: { data: 'hello' },
      },
      {
        seq: 1,
        ts: '2026-03-20T12:00:00.100Z',
        type: 'resize',
        payload: { cols: 12, rows: 5 },
      },
      {
        seq: 2,
        ts: '2026-03-20T12:00:00.200Z',
        type: 'output',
        payload: { data: ' world' },
      },
    ],
    ...overrides,
  };
}

function createNativeFixture(options: { visibleText?: string } = {}) {
  let cols = 80;
  let rows = 24;
  const feed = vi.fn();
  const resize = vi.fn((nextCols: number, nextRows: number) => {
    cols = nextCols;
    rows = nextRows;
  });
  const snapshot = vi.fn(() => ({
    cols,
    rows,
    cursorRow: Math.min(1, rows - 1),
    cursorCol: Math.min(2, cols - 1),
    isAltScreen: true,
    visibleLines: [
      { row: 0, text: 'hello world' },
      { row: 1, text: 'prompt>' },
    ],
    scrollbackLines: [{ row: 0, text: 'scrolled' }],
    cells: [
      {
        row: 0,
        col: 0,
        text: 'h',
        width: 1,
        bold: true,
        foreground: '#ffffff',
        background: '#000000',
      },
      {
        row: 0,
        col: 1,
        text: 'i',
        width: 1,
        italic: true,
      },
    ],
  }));
  const getVisibleText = vi.fn(
    () => options.visibleText ?? 'hello world\nprompt>',
  );
  const dispose = vi.fn();
  const terminal = { feed, resize, snapshot, getVisibleText, dispose };
  const createTerminal = vi.fn(
    (createOptions: { cols: number; rows: number }) => {
      cols = createOptions.cols;
      rows = createOptions.rows;
      return terminal;
    },
  );
  const module: LibghosttyVtNativeModule = {
    createTerminal,
    getNativeInfo: vi.fn(() => ({
      packageVersion: '0.1.0-beta.0',
      napiVersion: 10,
      platform: 'linux',
      arch: 'x64',
    })),
  };

  return {
    module,
    terminal,
    createTerminal,
    feed,
    resize,
    snapshot,
    getVisibleText,
    dispose,
  };
}


function createBackend(
  fixture = createNativeFixture(),
  options: Partial<ConstructorParameters<typeof LibghosttyVtBackend>[2]> = {},
): LibghosttyVtBackend {
  return new LibghosttyVtBackend('session-01', createProfile(), {
    loadNative: () => Promise.resolve(fixture.module),
    logger: createLogger('info', () => undefined),
    ...options,
  });
}

describe('LibghosttyVtBackend', () => {
  it('does not call the native loader before boot', () => {
    const loadNative = vi.fn();

    new LibghosttyVtBackend('session-01', createProfile(), {
      loadNative,
      logger: createLogger('info', () => undefined),
    });

    expect(loadNative).not.toHaveBeenCalled();
  });

  it('boots native terminal with configured dimensions', async () => {
    const fixture = createNativeFixture();
    const backend = createBackend(fixture, {
      initialCols: 100,
      initialRows: 30,
    });

    await backend.boot();

    expect(fixture.createTerminal).toHaveBeenCalledWith({
      cols: 100,
      rows: 30,
    });
    expect(backend.isBooted).toBe(true);
  });

  it('replays output and resize events into the native terminal', async () => {
    const fixture = createNativeFixture();
    const backend = createBackend(fixture);

    await backend.boot();
    const state = await backend.replayTo(createReplayInput());

    expect(fixture.feed).toHaveBeenCalledWith('hello');
    expect(fixture.feed).toHaveBeenCalledWith(' world');
    expect(fixture.resize).toHaveBeenNthCalledWith(1, 10, 4);
    expect(fixture.resize).toHaveBeenNthCalledWith(2, 12, 5);
    expect(state).toEqual({
      lastSeq: 2,
      cols: 12,
      rows: 5,
      cursorRow: 1,
      cursorCol: 2,
    });
  });

  it('skips run_complete events during replay', async () => {
    const fixture = createNativeFixture();
    const backend = createBackend(fixture);

    await backend.boot();
    const state = await backend.replayTo(
      createReplayInput({
        targetSeq: 3,
        events: [
          {
            seq: 0,
            ts: '2026-03-20T12:00:00.000Z',
            type: 'output',
            payload: { data: 'hello' },
          },
          {
            seq: 1,
            ts: '2026-03-20T12:00:00.100Z',
            type: 'run_complete',
            payload: {
              marker: '__AT_MARKER_00000000000000000000000000000001__',
            },
          },
          {
            seq: 2,
            ts: '2026-03-20T12:00:00.200Z',
            type: 'resize',
            payload: { cols: 12, rows: 5 },
          },
          {
            seq: 3,
            ts: '2026-03-20T12:00:00.300Z',
            type: 'output',
            payload: { data: ' world' },
          },
        ],
      }),
    );

    expect(fixture.feed).toHaveBeenCalledTimes(2);
    expect(fixture.feed).toHaveBeenNthCalledWith(1, 'hello');
    expect(fixture.feed).toHaveBeenNthCalledWith(2, ' world');
    expect(state.lastSeq).toBe(3);
  });

  it('maps native snapshots into semantic snapshots', async () => {
    const fixture = createNativeFixture();
    const backend = createBackend(fixture);

    await backend.boot();
    await backend.replayTo(createReplayInput());

    const snapshot = await backend.snapshot({
      includeScrollback: true,
      includeCells: true,
    });

    expect(fixture.snapshot).toHaveBeenLastCalledWith({
      includeScrollback: true,
      includeCells: true,
    });
    expect(snapshot).toMatchObject({
      sessionId: 'session-01',
      capturedAtSeq: 2,
      cols: 12,
      rows: 5,
      cursorRow: 1,
      cursorCol: 2,
      isAltScreen: true,
      visibleLines: [
        { row: 0, text: 'hello world' },
        { row: 1, text: 'prompt>' },
      ],
      scrollbackLines: [{ row: 0, text: 'scrolled' }],
      cells: [
        {
          lineNumber: 0,
          cells: [
            {
              char: 'h',
              fg: '#ffffff',
              bg: '#000000',
              bold: true,
            },
            { char: 'i', italic: true },
          ],
        },
      ],
    });
  });

  it('delegates getVisibleText to the native terminal', async () => {
    const fixture = createNativeFixture({ visibleText: 'delegated text' });
    const backend = createBackend(fixture);

    await backend.boot();

    await expect(backend.getVisibleText()).resolves.toBe('delegated text');
    expect(fixture.getVisibleText).toHaveBeenCalledTimes(1);
  });

  it('uses ghostty-web fallback for screenshots and preserves fallback metadata', async () => {
    const fixture = createNativeFixture();
    const fallback = createFakeBackend({
      rendererBackend: 'ghostty-web',
      writePng: false,
      resultOverrides: {
        capturedAtSeq: 2,
        cols: 12,
        rows: 5,
        pngSizeBytes: 123,
        rendererBackend: 'ghostty-web',
      },
    });
    const backend = createBackend(fixture, {
      fallbackFactory: () => fallback,
    });

    await backend.boot();
    const replayInput = createReplayInput();
    await backend.replayTo(replayInput);

    const result = await backend.screenshot('/tmp/screenshot.png', {
      showCursor: true,
    });

    expect(fallback.bootMock).toHaveBeenCalledTimes(1);
    expect(fallback.replayToMock).toHaveBeenCalledWith(replayInput);
    expect(fallback.screenshotMock).toHaveBeenCalledWith(
      '/tmp/screenshot.png',
      {
        showCursor: true,
      },
    );
    expect(result.rendererBackend).toBe('ghostty-web');
  });

  it('disposes native and fallback resources idempotently', async () => {
    const fixture = createNativeFixture();
    const fallback = createFakeBackend({
      rendererBackend: 'ghostty-web',
      writePng: false,
      resultOverrides: {
        capturedAtSeq: 2,
        cols: 12,
        rows: 5,
        pngSizeBytes: 123,
        rendererBackend: 'ghostty-web',
      },
    });
    const backend = createBackend(fixture, {
      fallbackFactory: () => fallback,
    });

    await backend.boot();
    await backend.replayTo(createReplayInput());
    await backend.screenshot('/tmp/screenshot.png');
    await backend.dispose();
    await backend.dispose();

    expect(fixture.dispose).toHaveBeenCalledTimes(1);
    expect(fallback.disposeMock).toHaveBeenCalledTimes(1);
    expect(backend.isBooted).toBe(false);
  });

  it('wraps boot failures with an actionable message', async () => {
    const backend = new LibghosttyVtBackend('session-01', createProfile(), {
      loadNative: () => Promise.reject(new Error('native unavailable')),
      logger: createLogger('info', () => undefined),
    });

    await expect(backend.boot()).rejects.toThrow(
      /@coder\/libghostty-vt-node.*--renderer ghostty-web/u,
    );
  });

  it('throws clearly when used after dispose', async () => {
    const backend = createBackend();

    await backend.boot();
    await backend.dispose();

    await expect(backend.getVisibleText()).rejects.toThrow(/after dispose/u);
  });
});
