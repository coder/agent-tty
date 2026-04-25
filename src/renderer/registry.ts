import type { RendererBackend } from './backend.js';
import type * as LibghosttyVtBackendModule from './libghosttyVt/backend.js';
import { GhosttyWebBackend } from './ghosttyWeb/index.js';
import type { LibghosttyVtBackendOptions } from './libghosttyVt/backend.js';
import { resolveRendererName, type RendererName } from './names.js';
import type { RenderProfileConfig } from './types.js';
import { invariant } from '../util/assert.js';

export interface RendererRegistryOptions {
  loadLibghosttyVtBackend?: () => Promise<typeof LibghosttyVtBackendModule>;
  libghosttyVt?: LibghosttyVtBackendOptions;
}

export async function createRendererBackend(
  rendererName: RendererName,
  sessionId: string,
  profile: RenderProfileConfig,
  options: RendererRegistryOptions = {},
): Promise<RendererBackend> {
  invariant(sessionId.length > 0, 'sessionId must be a non-empty string');
  invariant(profile.name.length > 0, 'profile.name must be a non-empty string');

  switch (resolveRendererName(rendererName)) {
    case 'ghostty-web':
      return new GhosttyWebBackend(sessionId, profile);
    case 'libghostty-vt': {
      const module = await (
        options.loadLibghosttyVtBackend ??
        (() => import('./libghosttyVt/backend.js'))
      )();
      return new module.LibghosttyVtBackend(
        sessionId,
        profile,
        options.libghosttyVt,
      );
    }
  }
}
