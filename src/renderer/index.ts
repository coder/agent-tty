export {
  BUILTIN_PROFILE_NAMES,
  getBuiltinProfile,
  hashProfile,
  resolveProfile,
} from './profiles.js';
export {
  RenderProfileConfigSchema,
  ReplayEventSchema,
  ReplayInputSchema,
  ReplayStateSchema,
  ScreenshotResultSchema,
  SemanticSnapshotSchema,
  TextSnapshotSchema,
} from './types.js';
export { VisibleLineSchema } from '../protocol/schemas.js';
export type { RendererBackend, SnapshotOptions } from './backend.js';
export {
  DEFAULT_RENDERER_NAME,
  DEFAULT_SEMANTIC_RENDERER_NAME,
  DEFAULT_VISUAL_RENDERER_NAME,
  RendererNameSchema,
  resolveRendererName,
} from './names.js';
export type { RendererName } from './names.js';
export { createRendererBackend } from './registry.js';
export { GhosttyWebBackend } from './ghosttyWeb/index.js';
export type {
  RenderProfileConfig,
  ReplayEvent,
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
  TextSnapshot,
} from './types.js';
export type { VisibleLine } from '../protocol/schemas.js';
