import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDERER_NAME,
  DEFAULT_SEMANTIC_RENDERER_NAME,
  DEFAULT_VISUAL_RENDERER_NAME,
  createRendererBackend,
  resolveRendererName,
} from '../../../src/renderer/index.js';
import type { RenderProfileConfig } from '../../../src/renderer/types.js';

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

describe('renderer registry', () => {
  it('resolves renderer default constants', () => {
    expect(DEFAULT_RENDERER_NAME).toBe('ghostty-web');
    expect(DEFAULT_SEMANTIC_RENDERER_NAME).toBe('libghostty-vt');
    expect(DEFAULT_VISUAL_RENDERER_NAME).toBe('ghostty-web');
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
    const fakeBackend = createFakeBackend({ rendererBackend: 'libghostty-vt' });
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
