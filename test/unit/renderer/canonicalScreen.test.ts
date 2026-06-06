import { describe, expect, it } from 'vitest';

import {
  canonicalVisibleLines,
  canonicalVisibleText,
  computeScreenHash,
} from '../../../src/renderer/canonicalScreen.js';

const linesOf = (...texts: string[]) => ({
  visibleLines: texts.map((text) => ({ text })),
});

describe('canonicalVisibleLines / canonicalVisibleText', () => {
  it('returns the verbatim line texts and their newline join', () => {
    const snapshot = linesOf('one', 'two', 'three');

    expect(canonicalVisibleLines(snapshot)).toEqual(['one', 'two', 'three']);
    expect(canonicalVisibleText(snapshot)).toBe('one\ntwo\nthree');
  });
});

describe('computeScreenHash', () => {
  it('returns the same hash for identical visible lines', () => {
    const a = linesOf('alpha', 'beta');
    const b = linesOf('alpha', 'beta');

    expect(computeScreenHash(a)).toBe(computeScreenHash(b));
  });

  it('ignores fields outside visibleLines (e.g. cursor position)', () => {
    const base = linesOf('alpha', 'beta');
    const withCursor = {
      ...base,
      cursorRow: 7,
      cursorCol: 13,
    };

    expect(computeScreenHash(withCursor)).toBe(computeScreenHash(base));
  });

  it('changes when a single glyph changes', () => {
    const before = linesOf('alpha', 'beta');
    const after = linesOf('alpha', 'beto');

    expect(computeScreenHash(after)).not.toBe(computeScreenHash(before));
  });

  it('changes when only trailing whitespace differs (no normalization)', () => {
    const trimmed = linesOf('alpha', 'beta');
    const trailing = linesOf('alpha', 'beta   ');

    expect(computeScreenHash(trailing)).not.toBe(computeScreenHash(trimmed));
  });

  it('pins the canonical digest of a fixed non-ASCII fixture', () => {
    // 'café' is "cafe" + a combining acute accent (NFD); '漢字' exercises
    // multibyte UTF-8; the third line carries trailing spaces. Pinning the
    // concrete digest locks the canonical string assembly and UTF-8 encoding.
    const fixture = linesOf('café', '漢字', 'trailing   ');

    expect(canonicalVisibleText(fixture)).toBe('café\n漢字\ntrailing   ');
    expect(computeScreenHash(fixture)).toBe(
      'e813b95ab8cd844d5a3eff7d6e447a3c3c0cc79300085c701f2b9193efbaa1f3',
    );
  });
});
