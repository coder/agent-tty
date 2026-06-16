import { z } from 'zod';

export const RendererNameSchema = z.enum(['ghostty-web', 'libghostty-vt']);
export type RendererName = z.infer<typeof RendererNameSchema>;

// Legacy/safe single-renderer fallback for internal paths that cannot yet
// distinguish semantic from visual defaults.
export const DEFAULT_RENDERER_NAME: RendererName = 'ghostty-web';
export const DEFAULT_SEMANTIC_RENDERER_NAME: RendererName = 'libghostty-vt';
export const DEFAULT_VISUAL_RENDERER_NAME: RendererName = 'ghostty-web';

export function resolveRendererName(input: string | undefined): RendererName {
  const candidate = input ?? DEFAULT_RENDERER_NAME;
  const result = RendererNameSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      `Renderer must be one of: ${RendererNameSchema.options.join(', ')}. Received: ${candidate}`,
      { cause: result.error },
    );
  }

  return result.data;
}
