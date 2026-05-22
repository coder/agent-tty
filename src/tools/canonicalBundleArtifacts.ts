import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type {
  CanonicalBundleArtifact,
  CanonicalBundleManifest,
} from './bundleManifestSchema.js';
import { CanonicalBundleManifestSchema } from './bundleManifestSchema.js';
import {
  readValidatedJsonFile,
  writeValidatedJsonFile,
} from '../storage/manifests.js';
import { invariant } from '../util/assert.js';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function canonicalBundleArtifactEntry(
  bundleDir: string,
  relativePath: string,
  description: string,
): Promise<CanonicalBundleArtifact> {
  const fullPath = join(bundleDir, relativePath);
  const stats = await stat(fullPath);
  return {
    path: relativePath,
    description,
    sha256: await sha256File(fullPath),
    bytes: stats.size,
  };
}

function validateCanonicalBundleManifest(
  _path: string,
  data: unknown,
): CanonicalBundleManifest {
  return CanonicalBundleManifestSchema.parse(data);
}

export async function readCanonicalBundleManifest(
  path: string,
): Promise<CanonicalBundleManifest> {
  const manifest = await readValidatedJsonFile({
    path,
    pathLabel: 'canonical bundle manifest path',
    allowMissing: false,
    readErrorMessage: `Failed to read canonical bundle manifest at ${path}.`,
    invalidJsonMessage: `Canonical bundle manifest contains invalid JSON at ${path}.`,
    validate: validateCanonicalBundleManifest,
  });
  invariant(manifest !== null, 'canonical bundle manifest must exist');
  return manifest;
}

export async function writeCanonicalBundleManifest(
  path: string,
  manifest: CanonicalBundleManifest,
): Promise<void> {
  await writeValidatedJsonFile({
    path,
    pathLabel: 'canonical bundle manifest path',
    data: manifest,
    writeErrorMessage: `Failed to write canonical bundle manifest at ${path}.`,
    validate: validateCanonicalBundleManifest,
  });
}
