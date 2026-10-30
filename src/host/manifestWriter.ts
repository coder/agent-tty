import type { SessionRecord } from '../protocol/schemas.js';
import { isTerminalSessionStatus } from '../protocol/sessionStatusPolicy.js';
import { writeManifest } from '../storage/manifests.js';

export function createSerialManifestWriter(
  path: string,
  snapshot: () => SessionRecord,
  write = writeManifest,
): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  let wroteTerminal = false;

  return () => {
    const next = tail.then(async () => {
      if (wroteTerminal) {
        return;
      }
      const record = snapshot();
      await write(path, record);
      wroteTerminal = isTerminalSessionStatus(record.status);
    });
    tail = next.catch(() => undefined);
    return next;
  };
}
