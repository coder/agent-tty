import { describe, expect, it } from 'vitest';

import {
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
} from '../../../src/renderer/bundledFont.js';
import { readFontCoverage } from '../../../src/renderer/fontCoverage.js';

describe('readFontCoverage', () => {
  it('reads the cmap of the bundled JetBrains Mono WOFF2 subset', () => {
    const coverage = readFontCoverage(BUNDLED_PRIMARY_FONT_ASSET.buffer);

    for (const char of 'Az09~ é€…') {
      expect(coverage.has(char.codePointAt(0) ?? -1), char).toBe(true);
    }
    expect(coverage.has(0x29c9)).toBe(false);
    expect(coverage.has(0x2502)).toBe(false);
    expect(coverage.has(0xe0b0)).toBe(false);
  });

  it('reads the cmap of the bundled Symbols Nerd Font TTF, BMP and astral', () => {
    const coverage = readFontCoverage(BUNDLED_SYMBOLS_FONT_ASSET.buffer);

    expect(coverage.has(0xe0b0)).toBe(true);
    expect(coverage.has(0xf0001)).toBe(true);
    expect(coverage.has(0x41)).toBe(false);
    expect(coverage.has(0x29c9)).toBe(false);
  });

  it('rejects bytes that are not a font', () => {
    expect(() => readFontCoverage(Buffer.from('not a font file'))).toThrow(
      'font must be a TrueType, OpenType or WOFF2 file',
    );
  });
});
