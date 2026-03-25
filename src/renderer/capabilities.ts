import { z } from 'zod';

// --- Capability vocabulary ---

export const CapabilityNameSchema = z.enum([
  'snapshot',
  'wait',
  'screenshot',
  'record-export-asciicast',
  'record-export-webm',
]);
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

export const CapabilityStatusSchema = z.enum([
  'available',
  'unavailable',
  'degraded',
  'unknown',
]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityEntrySchema = z
  .object({
    name: CapabilityNameSchema,
    status: CapabilityStatusSchema,
    reason: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;

// --- Renderer runtime summary (for inspect) ---

export const RendererRuntimeModeSchema = z.enum(['live-host', 'offline-replay']);
export type RendererRuntimeMode = z.infer<typeof RendererRuntimeModeSchema>;

export const RendererRuntimeStatusSchema = z.enum([
  'healthy',
  'fallback',
  'unavailable',
]);
export type RendererRuntimeStatus = z.infer<typeof RendererRuntimeStatusSchema>;

export const RendererRuntimeSummarySchema = z
  .object({
    backend: z.string(),
    mode: RendererRuntimeModeSchema,
    status: RendererRuntimeStatusSchema,
    reason: z.string().optional(),
  })
  .strict();
export type RendererRuntimeSummary = z.infer<typeof RendererRuntimeSummarySchema>;

// --- Discovery modes ---

export type DiscoveryMode = 'quick' | 'full';

/**
 * Discover runtime capabilities.
 *
 * - 'quick' mode: fast checks suitable for `version --json` (no browser launch).
 * - 'full' mode: thorough probing suitable for `doctor --json` (may launch browser).
 *
 * Stub — actual implementation lands in Phase A.
 */
export async function discoverCapabilities(
  _mode: DiscoveryMode,
): Promise<CapabilityEntry[]> {
  void _mode;
  await Promise.resolve();
  // Phase A will implement actual discovery logic.
  throw new Error('discoverCapabilities is not yet implemented');
}
