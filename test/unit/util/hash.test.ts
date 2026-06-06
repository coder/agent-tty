import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/util/hash.js';

describe('sha256Hex', () => {
  it('matches the known SHA-256 digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns the empty-string digest for ""', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes the UTF-8 bytes of a non-ASCII string', () => {
    const value = 'café漢字';

    expect(sha256Hex(value)).toBe(
      createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex'),
    );
  });
});
