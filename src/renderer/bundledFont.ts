import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { invariant } from '../util/assert.js';

const BUNDLED_FONT_PATH_PREFIX = 'ghosttyWeb/assets/';
const SHA_256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

interface BundledFontAssetSource {
  assetKey: string;
  contentType: string;
  family: string;
  filename: string;
  style: 'italic' | 'normal' | 'oblique';
  weight: string;
}

interface BundledFontAsset extends BundledFontAssetSource {
  assetIdentity: string;
  buffer: Buffer;
  route: string;
}

const BUNDLED_FONT_ASSET_SOURCES = [
  {
    assetKey: 'jetbrains-mono-regular-latin',
    contentType: 'font/woff2',
    family: 'JetBrains Mono',
    filename: 'JetBrainsMono-Regular-latin.woff2',
    style: 'normal',
    weight: '400',
  },
  {
    assetKey: 'symbols-nerd-font-mono-regular',
    contentType: 'font/ttf',
    family: 'Symbols Nerd Font Mono',
    filename: 'SymbolsNerdFontMono-Regular.ttf',
    style: 'normal',
    weight: '400',
  },
] as const satisfies readonly BundledFontAssetSource[];

function loadBundledFontAsset(
  source: BundledFontAssetSource,
): Readonly<BundledFontAsset> {
  const assetPath = new URL(
    `${BUNDLED_FONT_PATH_PREFIX}${source.filename}`,
    import.meta.url,
  );
  const buffer = readFileSync(assetPath);
  invariant(
    buffer.byteLength > 0,
    `bundled font asset ${source.filename} must not be empty`,
  );

  const assetIdentity = createHash('sha256').update(buffer).digest('hex');
  invariant(
    SHA_256_HEX_PATTERN.test(assetIdentity),
    `bundled font asset ${source.filename} identity must be a valid SHA-256 hex string`,
  );

  return Object.freeze({
    ...source,
    assetIdentity,
    buffer,
    route: `/assets/fonts/${source.filename}`,
  });
}

const bundledFontAssets = BUNDLED_FONT_ASSET_SOURCES.map(loadBundledFontAsset);
invariant(
  bundledFontAssets.length > 0,
  'bundled font registry must not be empty',
);

const bundledFontAssetsByIdentity = new Map(
  bundledFontAssets.map((asset) => [asset.assetIdentity, asset] as const),
);
invariant(
  bundledFontAssetsByIdentity.size === bundledFontAssets.length,
  'bundled font registry must not contain duplicate asset identities',
);

const bundledFontAssetsByKey = new Map(
  bundledFontAssets.map((asset) => [asset.assetKey, asset] as const),
);
invariant(
  bundledFontAssetsByKey.size === bundledFontAssets.length,
  'bundled font registry must not contain duplicate asset keys',
);

export const BUNDLED_FONT_ASSETS = Object.freeze(bundledFontAssets);
export const BUNDLED_FONT_FAMILY = 'JetBrains Mono';
export const BUNDLED_SYMBOLS_FONT_FAMILY = 'Symbols Nerd Font Mono';
export const BUNDLED_FONT_ASSET_FILENAME = 'JetBrainsMono-Regular-latin.woff2';
export const BUNDLED_FONT_CONTENT_TYPE = 'font/woff2';
export const BUNDLED_FONT_ROUTE = `/assets/fonts/${BUNDLED_FONT_ASSET_FILENAME}`;

const primaryBundledFont = bundledFontAssetsByKey.get(
  'jetbrains-mono-regular-latin',
);
invariant(
  primaryBundledFont !== undefined,
  'JetBrains Mono bundled font asset must exist in the registry',
);

const symbolsBundledFont = bundledFontAssetsByKey.get(
  'symbols-nerd-font-mono-regular',
);
invariant(
  symbolsBundledFont !== undefined,
  'Symbols Nerd Font Mono bundled font asset must exist in the registry',
);

export const BUNDLED_PRIMARY_FONT_ASSET = primaryBundledFont;
export const BUNDLED_SYMBOLS_FONT_ASSET = symbolsBundledFont;
export const BUNDLED_FONT_ASSET_IDENTITY =
  BUNDLED_PRIMARY_FONT_ASSET.assetIdentity;
export const BUNDLED_FONT_BUFFER = BUNDLED_PRIMARY_FONT_ASSET.buffer;

export function getBundledFontAssetByIdentity(
  assetIdentity: string,
): Readonly<BundledFontAsset> | undefined {
  invariant(
    SHA_256_HEX_PATTERN.test(assetIdentity),
    'bundled font asset identity lookup requires a SHA-256 hex string',
  );
  return bundledFontAssetsByIdentity.get(assetIdentity);
}

export type { BundledFontAsset };
