import { createHash } from 'node:crypto';

/**
 * Returns the lowercase 64-character SHA-256 hex digest of the UTF-8 bytes of
 * `text`.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
