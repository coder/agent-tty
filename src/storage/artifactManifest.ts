import { rm } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

import { ulid } from 'ulid';
import { z } from 'zod';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { readValidatedJsonFile, writeValidatedJsonFile } from './manifests.js';
import { artifactPath } from './artifactPaths.js';
import { invariant } from '../util/assert.js';
import { KeyedSerializer } from '../util/keyedSerializer.js';

const ARTIFACT_MANIFEST_FILENAME = 'manifest.json';
const NonEmptyStringSchema = z.string().min(1);
const NonNegativeIntSchema = z.number().int().nonnegative();
const IsoDatetimeSchema = z.iso.datetime();
const ArtifactKindSchema = z.enum([
  'screenshot',
  'snapshot',
  'recording',
  'video',
]);

export const ArtifactEntrySchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: ArtifactKindSchema,
    filename: NonEmptyStringSchema.refine(
      (value) => !value.includes('/') && !value.includes('\\'),
      'filename must not contain path separators',
    ),
    sessionId: NonEmptyStringSchema,
    capturedAtSeq: NonNegativeIntSchema,
    createdAt: IsoDatetimeSchema,
    sha256: z
      .string()
      .regex(
        /^[a-f0-9]{64}$/,
        'sha256 must be a 64-character lowercase hex string',
      )
      .optional(),
    bytes: z.number().int().nonnegative().optional(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

export const ArtifactManifestSchema = z
  .object({
    version: z.literal(1),
    sessionId: NonEmptyStringSchema,
    artifacts: z.array(ArtifactEntrySchema),
  })
  .strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

const appendSerializer = new KeyedSerializer<string>();

function artifactManifestPath(sessionDir: string): string {
  return artifactPath(sessionDir, ARTIFACT_MANIFEST_FILENAME);
}

function sessionIdFromSessionDir(sessionDir: string): string {
  const sessionId = basename(resolve(sessionDir));
  invariant(
    sessionId.length > 0,
    'sessionDir must resolve to a non-empty sessionId',
  );
  return sessionId;
}

function validateArtifactManifestData(
  path: string,
  data: unknown,
  expectedSessionId: string,
): ArtifactManifest {
  const parsedManifest = ArtifactManifestSchema.safeParse(data);

  if (!parsedManifest.success) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact manifest validation failed for ${path}.`,
      details: {
        path,
        issues: parsedManifest.error.issues,
      },
    });
  }

  if (parsedManifest.data.sessionId !== expectedSessionId) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact manifest sessionId mismatch for ${path}.`,
      details: {
        path,
        expectedSessionId,
        actualSessionId: parsedManifest.data.sessionId,
      },
    });
  }

  return parsedManifest.data;
}

function validateArtifactEntry(
  entry: ArtifactEntry,
  expectedSessionId: string,
): ArtifactEntry {
  const parsedEntry = ArtifactEntrySchema.safeParse(entry);

  if (!parsedEntry.success) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact entry validation failed for session ${expectedSessionId}.`,
      details: {
        sessionId: expectedSessionId,
        issues: parsedEntry.error.issues,
      },
    });
  }

  if (parsedEntry.data.sessionId !== expectedSessionId) {
    throw makeCliError(ERROR_CODES.MANIFEST_VALIDATION_ERROR, {
      message: `Artifact entry sessionId mismatch for session ${expectedSessionId}.`,
      details: {
        expectedSessionId,
        actualSessionId: parsedEntry.data.sessionId,
      },
    });
  }

  return parsedEntry.data;
}

function emptyArtifactManifest(sessionDir: string): ArtifactManifest {
  return {
    version: 1,
    sessionId: sessionIdFromSessionDir(sessionDir),
    artifacts: [],
  };
}

export async function readArtifactManifest(
  sessionDir: string,
): Promise<ArtifactManifest> {
  const path = artifactManifestPath(sessionDir);
  const expectedSessionId = sessionIdFromSessionDir(sessionDir);
  const manifest = await readValidatedJsonFile({
    path,
    pathLabel: 'artifact manifest path',
    allowMissing: true,
    readErrorMessage: `Failed to read artifact manifest at ${path}.`,
    invalidJsonMessage: `Artifact manifest contains invalid JSON at ${path}.`,
    validate: (manifestPath, data) =>
      validateArtifactManifestData(manifestPath, data, expectedSessionId),
  });

  return manifest ?? emptyArtifactManifest(sessionDir);
}

export async function writeArtifactManifest(
  sessionDir: string,
  manifest: ArtifactManifest,
): Promise<void> {
  const path = artifactManifestPath(sessionDir);
  const expectedSessionId = sessionIdFromSessionDir(sessionDir);

  await writeValidatedJsonFile({
    path,
    pathLabel: 'artifact manifest path',
    data: manifest,
    writeErrorMessage: `Failed to write artifact manifest at ${path}.`,
    validate: (manifestPath, data) =>
      validateArtifactManifestData(manifestPath, data, expectedSessionId),
  });
}

export interface AppendArtifactWithRollbackOptions {
  sessionDir: string;
  entry: ArtifactEntry;
  rollbackArtifactPath?: string;
}

async function appendArtifact(
  sessionDir: string,
  entry: ArtifactEntry,
  rollbackArtifactPath: string | undefined,
): Promise<void> {
  const resolvedSessionDir = resolve(sessionDir);
  const expectedSessionId = sessionIdFromSessionDir(resolvedSessionDir);
  await appendSerializer.run(resolvedSessionDir, async () => {
    try {
      const validatedEntry = validateArtifactEntry(entry, expectedSessionId);
      const manifest = await readArtifactManifest(resolvedSessionDir);
      await writeArtifactManifest(resolvedSessionDir, {
        ...manifest,
        artifacts: [...manifest.artifacts, validatedEntry],
      });
    } catch (error) {
      if (rollbackArtifactPath !== undefined) {
        // Best-effort: swallow rm errors so the original manifest failure propagates.
        await rm(rollbackArtifactPath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  });
}

/**
 * Append an artifact entry to the session manifest, removing the artifact file
 * at `rollbackArtifactPath` if the append fails. Rollback is best-effort: rm
 * errors are swallowed so the original manifest error propagates.
 */
export async function appendArtifactWithRollback(
  options: AppendArtifactWithRollbackOptions,
): Promise<void> {
  if (options.rollbackArtifactPath !== undefined) {
    invariant(
      options.rollbackArtifactPath.length > 0,
      'rollbackArtifactPath must be a non-empty string',
    );
    invariant(
      isAbsolute(options.rollbackArtifactPath),
      'rollbackArtifactPath must be absolute',
    );
  }

  await appendArtifact(
    options.sessionDir,
    options.entry,
    options.rollbackArtifactPath,
  );
}

export function createArtifactEntry(
  entry: Omit<ArtifactEntry, 'id' | 'createdAt'>,
): ArtifactEntry {
  return {
    ...entry,
    id: ulid(),
    createdAt: new Date().toISOString(),
  };
}
