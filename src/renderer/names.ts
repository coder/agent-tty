import { z } from 'zod';

export const RendererNameSchema = z.enum(['ghostty-web', 'libghostty-vt']);
export type RendererName = z.infer<typeof RendererNameSchema>;

export const DEFAULT_RENDERER_NAME: RendererName = 'ghostty-web';

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
