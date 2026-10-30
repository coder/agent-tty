import type { SessionRecord } from '../protocol/schemas.js';
import { writeManifest } from '../storage/manifests.js';

// Writes run in call order, and each takes its snapshot when its turn starts.
// A write whose snapshot equals the last written one is skipped: once the
// record is terminal it never changes, so the terminal write stays the last.
export function createSerialManifestWriter(
  path: string,
  snapshot: () => SessionRecord,
  write = writeManifest,
): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  let lastWritten: string | null = null;

  return () => {
    const next = tail.then(async () => {
      const record = snapshot();
      const text = JSON.stringify(record);
      if (text === lastWritten) {
        return;
      }
      await write(path, record);
      lastWritten = text;
    });
    tail = next.catch(() => undefined);
    return next;
  };
}
