import { describe, expect, it } from 'vitest';

import {
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
} from '../../../src/renderer/bundledFont.js';
import {
  profileFaces,
  readFontCoverage,
  readFontFile,
} from '../../../src/renderer/fontCoverage.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';

const PROFILE = resolveProfile('reference-dark');

function face(
  asset: typeof BUNDLED_PRIMARY_FONT_ASSET,
  family: string,
  weight: string,
) {
  return {
    family,
    assetIdentity: asset.assetIdentity,
    route: asset.route,
    weight,
    style: 'normal' as const,
  };
}

describe('readFontFile', () => {
  it('reads the PostScript name and the cmap of the bundled WOFF2 and TTF fonts', () => {
    const jetBrains = readFontFile(BUNDLED_PRIMARY_FONT_ASSET.buffer);
    const symbols = readFontFile(BUNDLED_SYMBOLS_FONT_ASSET.buffer);

    expect(jetBrains.postScriptName).toBe('JetBrainsMono-Regular');
    expect(symbols.postScriptName).toBe('SymbolsNFM');
    expect(jetBrains.coverage.has(0x41)).toBe(true);
    expect(jetBrains.coverage.has(0xe0b0)).toBe(false);
    expect(symbols.coverage.has(0xe0b0)).toBe(true);
    expect(symbols.coverage.has(0xf0001)).toBe(true);
  });
});

describe('profileFaces', () => {
  it('keeps two assets under one family as two faces with their own coverage', () => {
    const faces = profileFaces({
      ...PROFILE,
      fontFamily: '"Term", monospace',
      fontAssets: [
        face(BUNDLED_PRIMARY_FONT_ASSET, 'Term', '400'),
        face(BUNDLED_SYMBOLS_FONT_ASSET, 'Term', '700'),
      ],
    });

    expect(
      faces?.map((family) => family.map((font) => font.postScriptName)),
    ).toEqual([['JetBrainsMono-Regular', 'SymbolsNFM']]);
    expect(faces?.[0][0].coverage.has(0xe0b0)).toBe(false);
    expect(faces?.[0][1]?.coverage.has(0xe0b0)).toBe(true);
  });
});

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
