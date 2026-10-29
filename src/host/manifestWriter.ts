import type { SessionRecord } from '../protocol/schemas.js';
import { writeManifest } from '../storage/manifests.js';

export function createSerialManifestWriter(
  path: string,
  snapshot: () => SessionRecord,
  write = writeManifest,
): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();

  return () => {
    const next = tail.then(() => write(path, snapshot()));
    tail = next.catch(() => undefined);
    return next;
  };
}
