import { describe, expect, it } from 'vitest';

import {
  BUNDLED_FONT_ASSETS,
  BUNDLED_PRIMARY_FONT_ASSET,
  BUNDLED_SYMBOLS_FONT_ASSET,
} from '../../../src/renderer/bundledFont.js';
import {
  profileFaces,
  readFontFile,
} from '../../../src/renderer/fontCoverage.js';
import { resolveProfile } from '../../../src/renderer/profiles.js';
import type { RenderProfileConfig } from '../../../src/renderer/types.js';

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

  it('reads the cmap of the bundled JetBrains Mono WOFF2 subset', () => {
    const { coverage } = readFontFile(BUNDLED_PRIMARY_FONT_ASSET.buffer);

    for (const char of 'Az09~ é€…') {
      expect(coverage.has(char.codePointAt(0) ?? -1), char).toBe(true);
    }
    expect(coverage.has(0x29c9)).toBe(false);
    expect(coverage.has(0x2502)).toBe(false);
    expect(coverage.has(0xe0b0)).toBe(false);
  });

  it('reads the cmap of the bundled Symbols Nerd Font TTF, BMP and astral', () => {
    const { coverage } = readFontFile(BUNDLED_SYMBOLS_FONT_ASSET.buffer);

    expect(coverage.has(0xe0b0)).toBe(true);
    expect(coverage.has(0xf0001)).toBe(true);
    expect(coverage.has(0x41)).toBe(false);
    expect(coverage.has(0x29c9)).toBe(false);
  });

  it('rejects bytes that are not a font', () => {
    expect(() => readFontFile(Buffer.from('not a font file'))).toThrow(
      'font must be a TrueType, OpenType or WOFF2 file',
    );
  });

  it('gives every bundled font its own PostScript name, the name CDP reports', () => {
    const names = BUNDLED_FONT_ASSETS.map(
      (asset) => readFontFile(asset.buffer).postScriptName,
    );

    expect(new Set(names).size).toBe(BUNDLED_FONT_ASSETS.length);
  });
});

describe('profileFaces', () => {
  const names = (profile: RenderProfileConfig) =>
    profileFaces(profile)?.map((family) =>
      family.map((font) => font.postScriptName),
    );

  it('lists the bundled families of the reference profile in stack order', () => {
    expect(names(PROFILE)).toEqual([['JetBrainsMono-Regular'], ['SymbolsNFM']]);
  });

  it('returns null when the font stack does not start with a bundled font', () => {
    expect(profileFaces({ ...PROFILE, fontFamily: 'monospace' })).toBeNull();
    expect(
      profileFaces({
        ...PROFILE,
        fontFamily: `monospace, ${PROFILE.fontFamily}`,
      }),
    ).toBeNull();
  });

  it('leaves out bundled fonts that the stack does not name', () => {
    expect(
      names({ ...PROFILE, fontFamily: '"JetBrains Mono", monospace' }),
    ).toEqual([['JetBrainsMono-Regular']]);
  });

  it('keeps a bundled family that the stack names after the generic family', () => {
    expect(
      names({
        ...PROFILE,
        fontFamily: '"JetBrains Mono", monospace, "Symbols Nerd Font Mono"',
      }),
    ).toEqual([['JetBrainsMono-Regular'], ['SymbolsNFM']]);
  });

  it('matches family names without regard to case, as CSS does', () => {
    expect(
      names({
        ...PROFILE,
        fontFamily: '"jetbrains mono", "SYMBOLS NERD FONT MONO", monospace',
      }),
    ).toEqual([['JetBrainsMono-Regular'], ['SymbolsNFM']]);
  });
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
