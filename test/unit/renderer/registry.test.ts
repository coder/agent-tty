import { describe, expect, it, vi } from 'vitest';

import type { RendererBackend } from '../../../src/renderer/backend.js';
import {
  DEFAULT_RENDERER_NAME,
  createRendererBackend,
  resolveRendererName,
} from '../../../src/renderer/index.js';
import type {
  RenderProfileConfig,
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from '../../../src/renderer/types.js';

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

function createFakeBackend(rendererBackend: string): RendererBackend {
  return {
    rendererBackend,
    isBooted: false,
    boot: vi.fn().mockResolvedValue(undefined),
    replayTo: vi.fn(
      (input: ReplayInput): Promise<ReplayState> =>
        Promise.resolve({
          lastSeq: input.targetSeq,
          cols: input.initialCols,
          rows: input.initialRows,
          cursorRow: 0,
          cursorCol: 0,
        }),
    ),
    snapshot: vi.fn(
      (): Promise<SemanticSnapshot> =>
        Promise.resolve({
          sessionId: 'session-01',
          capturedAtSeq: 0,
          cols: 80,
          rows: 24,
          cursorRow: 0,
          cursorCol: 0,
          isAltScreen: false,
          visibleLines: [],
        }),
    ),
    screenshot: vi.fn(
      (outputPath: string): Promise<ScreenshotResult> =>
        Promise.resolve({
          sessionId: 'session-01',
          capturedAtSeq: 0,
          profileName: 'reference-dark',
          cols: 80,
          rows: 24,
          artifactPath: outputPath,
          pngSizeBytes: 1,
        }),
    ),
    getVisibleText: vi.fn().mockResolvedValue(''),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('renderer registry', () => {
  it('resolves the default renderer name', () => {
    expect(DEFAULT_RENDERER_NAME).toBe('ghostty-web');
    expect(resolveRendererName(undefined)).toBe('ghostty-web');
  });

  it('accepts known renderer names and rejects unknown names', () => {
    expect(resolveRendererName('ghostty-web')).toBe('ghostty-web');
    expect(resolveRendererName('libghostty-vt')).toBe('libghostty-vt');
    expect(() => resolveRendererName('canvas')).toThrow(
      /Renderer must be one of/u,
    );
  });

  it('does not load the native backend module for ghostty-web', async () => {
    const loadLibghosttyVtBackend = vi.fn();

    const backend = await createRendererBackend(
      'ghostty-web',
      'session-01',
      createProfile(),
      { loadLibghosttyVtBackend },
    );

    expect(backend.rendererBackend).toBe('ghostty-web');
    expect(loadLibghosttyVtBackend).not.toHaveBeenCalled();
  });

  it('lazy-loads the native backend module for libghostty-vt only', async () => {
    const fakeBackend = createFakeBackend('libghostty-vt');
    const LibghosttyVtBackend = vi.fn(function FakeLibghosttyVtBackend() {
      return fakeBackend;
    });
    const loadLibghosttyVtBackend = vi.fn().mockResolvedValue({
      LibghosttyVtBackend,
    });

    const backend = await createRendererBackend(
      'libghostty-vt',
      'session-01',
      createProfile(),
      { loadLibghosttyVtBackend },
    );

    expect(loadLibghosttyVtBackend).toHaveBeenCalledTimes(1);
    expect(LibghosttyVtBackend).toHaveBeenCalledWith(
      'session-01',
      expect.objectContaining({ name: 'reference-dark' }),
      undefined,
    );
    expect(backend).toBe(fakeBackend);
  });
});
