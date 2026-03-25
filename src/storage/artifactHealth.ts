import { access } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  ArtifactHealthSummarySchema,
  type ArtifactHealthSummary,
} from '../protocol/messages.js';
import { ERROR_CODES } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';
import { readArtifactManifest } from './artifactManifest.js';
import { artifactPath } from './artifactPaths.js';

interface NodeError {
  code?: string;
}

function isManifestValidationError(error: unknown): error is Error & NodeError {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeError).code === ERROR_CODES.MANIFEST_VALIDATION_ERROR
  );
}

function validateArtifactHealthSummary(
  summary: ArtifactHealthSummary,
): ArtifactHealthSummary {
  const parsedSummary = ArtifactHealthSummarySchema.safeParse(summary);

  invariant(
    parsedSummary.success,
    'artifact health summary must satisfy ArtifactHealthSummarySchema',
  );

  return parsedSummary.data;
}

export async function computeArtifactHealth(
  sessionDir: string,
): Promise<ArtifactHealthSummary> {
  invariant(sessionDir.length > 0, 'sessionDir must be a non-empty string');
  invariant(isAbsolute(sessionDir), 'sessionDir must be an absolute path');

  const normalizedSessionDir = resolve(sessionDir);

  let manifest;
  try {
    manifest = await readArtifactManifest(normalizedSessionDir);
  } catch (error) {
    if (isManifestValidationError(error)) {
      return validateArtifactHealthSummary({
        total: 0,
        byKind: {},
        missingCount: 0,
        health: 'manifest-invalid',
      });
    }

    throw error;
  }

  if (manifest.artifacts.length === 0) {
    return validateArtifactHealthSummary({
      total: 0,
      byKind: {},
      missingCount: 0,
      health: 'no-artifacts',
    });
  }

  const byKind: Record<string, number> = {};
  for (const artifact of manifest.artifacts) {
    byKind[artifact.kind] = (byKind[artifact.kind] ?? 0) + 1;
  }

  const missingArtifacts = (
    await Promise.all(
      manifest.artifacts.map(async (artifact) => {
        try {
          await access(artifactPath(normalizedSessionDir, artifact.filename));
          return null;
        } catch {
          // Treat all access errors (ENOENT, EACCES, EIO, etc.) as
          // missing/inaccessible. Artifact health is diagnostic, not
          // a reason to crash the caller.
          return {
            id: artifact.id,
            kind: artifact.kind,
            filename: artifact.filename,
          };
        }
      }),
    )
  ).filter(
    (artifact): artifact is NonNullable<typeof artifact> => artifact !== null,
  );

  const missingCount = missingArtifacts.length;

  return validateArtifactHealthSummary({
    total: manifest.artifacts.length,
    byKind,
    missingCount,
    health: missingCount === 0 ? 'healthy' : 'missing-artifacts',
    ...(missingCount > 0 ? { missing: missingArtifacts } : {}),
  });
}
