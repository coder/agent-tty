import { z } from 'zod';

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

export const CanonicalBundleArtifactSchema = z
  .object({
    path: z.string().min(1),
    description: z.string().min(1),
    sha256: z.string().regex(SHA256_HEX_REGEX),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type CanonicalBundleArtifact = z.infer<
  typeof CanonicalBundleArtifactSchema
>;

export const CanonicalBundleManifestSchema = z
  .object({
    bundle: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    result: z.enum(['pass', 'fail', 'partial']),
    commands: z.array(z.string().min(1)).min(1),
    artifacts: z.array(CanonicalBundleArtifactSchema).min(1),
    week: z.number().int().optional(),
    scenario: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalBundleManifest = z.infer<
  typeof CanonicalBundleManifestSchema
>;
