import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { invariant } from '../util/assert.js';

const BUNDLED_FONT_ASSET_FILENAME = 'JetBrainsMono-Regular-latin.woff2';
const BUNDLED_FONT_FAMILY = 'JetBrains Mono';
const BUNDLED_FONT_CONTENT_TYPE = 'font/woff2';
const BUNDLED_FONT_ROUTE = `/assets/fonts/${BUNDLED_FONT_ASSET_FILENAME}`;

const fontAssetPath = new URL(
  `ghosttyWeb/assets/${BUNDLED_FONT_ASSET_FILENAME}`,
  import.meta.url,
);

const fontBuffer = readFileSync(fontAssetPath);
invariant(fontBuffer.byteLength > 0, 'bundled font asset must not be empty');

const fontAssetIdentity = createHash('sha256').update(fontBuffer).digest('hex');
invariant(
  /^[a-f0-9]{64}$/u.test(fontAssetIdentity),
  'bundled font asset identity must be a valid SHA-256 hex string',
);

export {
  BUNDLED_FONT_ASSET_FILENAME,
  BUNDLED_FONT_CONTENT_TYPE,
  BUNDLED_FONT_FAMILY,
  BUNDLED_FONT_ROUTE,
  fontAssetIdentity as BUNDLED_FONT_ASSET_IDENTITY,
  fontBuffer as BUNDLED_FONT_BUFFER,
};
