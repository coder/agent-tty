export { BUILTIN_PROFILE_NAMES, getBuiltinProfile, resolveProfile } from './profiles.js';
export {
  RenderProfileConfigSchema,
  ReplayEventSchema,
  ReplayInputSchema,
  ReplayStateSchema,
  ScreenshotResultSchema,
  SemanticSnapshotSchema,
  TextSnapshotSchema,
  VisibleLineSchema,
} from './types.js';
export type { RendererBackend } from './backend.js';
export { GhosttyWebBackend } from './ghosttyWeb/index.js';
export type {
  RenderProfileConfig,
  ReplayEvent,
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
  TextSnapshot,
  VisibleLine,
} from './types.js';
