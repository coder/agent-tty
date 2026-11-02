import { brotliDecompressSync } from 'node:zlib';

import { invariant } from '../util/assert.js';
import { BUNDLED_FONT_ASSETS } from './bundledFont.js';

const WOFF2_SIGNATURE = 0x774f4632;
const WOFF2_HEADER_SIZE = 48;
const WOFF2_CMAP_TAG_INDEX = 0;
const WOFF2_CUSTOM_TAG_INDEX = 63;
const WOFF2_GLYF_TAG_INDEX = 10;
const WOFF2_LOCA_TAG_INDEX = 11;
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565]);

function readUIntBase128(bytes: Buffer, cursor: { offset: number }): number {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    invariant(cursor.offset < bytes.length, 'WOFF2 directory is truncated');
    const byte = bytes.readUInt8(cursor.offset);
    cursor.offset += 1;
    invariant(
      !(index === 0 && byte === 0x80),
      'WOFF2 UIntBase128 has a leading zero',
    );
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return value;
    }
  }
  throw new Error('WOFF2 UIntBase128 is longer than 5 bytes');
}

function woff2CmapTable(bytes: Buffer): Buffer {
  const tableCount = bytes.readUInt16BE(12);
  const compressedSize = bytes.readUInt32BE(20);
  const cursor = { offset: WOFF2_HEADER_SIZE };
  let streamOffset = 0;
  let cmap: { offset: number; length: number } | null = null;
  for (let table = 0; table < tableCount; table += 1) {
    const flags = bytes.readUInt8(cursor.offset);
    cursor.offset += 1;
    const tagIndex = flags & 0x3f;
    const transformVersion = flags >> 6;
    if (tagIndex === WOFF2_CUSTOM_TAG_INDEX) {
      cursor.offset += 4;
    }
    const originalLength = readUIntBase128(bytes, cursor);
    const isGlyfOrLoca =
      tagIndex === WOFF2_GLYF_TAG_INDEX || tagIndex === WOFF2_LOCA_TAG_INDEX;
    const transformed = isGlyfOrLoca
      ? transformVersion === 0
      : transformVersion !== 0;
    const storedLength = transformed
      ? readUIntBase128(bytes, cursor)
      : originalLength;
    if (tagIndex === WOFF2_CMAP_TAG_INDEX) {
      invariant(!transformed, 'WOFF2 cmap table must not be transformed');
      cmap = { offset: streamOffset, length: storedLength };
    }
    streamOffset += storedLength;
  }

  invariant(cmap !== null, 'WOFF2 font has no cmap table');
  invariant(
    cursor.offset + compressedSize <= bytes.length,
    'WOFF2 compressed stream is truncated',
  );
  const stream = brotliDecompressSync(
    bytes.subarray(cursor.offset, cursor.offset + compressedSize),
  );
  invariant(
    stream.length === streamOffset,
    'WOFF2 decompressed stream length must match its table directory',
  );
  return stream.subarray(cmap.offset, cmap.offset + cmap.length);
}

function sfntCmapTable(bytes: Buffer): Buffer {
  const tableCount = bytes.readUInt16BE(4);
  for (let table = 0; table < tableCount; table += 1) {
    const record = 12 + table * 16;
    if (bytes.toString('latin1', record, record + 4) === 'cmap') {
      const offset = bytes.readUInt32BE(record + 8);
      const length = bytes.readUInt32BE(record + 12);
      invariant(offset + length <= bytes.length, 'sfnt cmap is truncated');
      return bytes.subarray(offset, offset + length);
    }
  }
  throw new Error('sfnt font has no cmap table');
}

function addFormat4(cmap: Buffer, offset: number, codePoints: Set<number>) {
  const segmentCountX2 = cmap.readUInt16BE(offset + 6);
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCountX2 + 2;
  const idDeltas = startCodes + segmentCountX2;
  const idRangeOffsets = idDeltas + segmentCountX2;
  for (let segment = 0; segment < segmentCountX2 / 2; segment += 1) {
    const end = cmap.readUInt16BE(endCodes + segment * 2);
    const start = cmap.readUInt16BE(startCodes + segment * 2);
    const delta = cmap.readUInt16BE(idDeltas + segment * 2);
    const rangeOffsetAddress = idRangeOffsets + segment * 2;
    const rangeOffset = cmap.readUInt16BE(rangeOffsetAddress);
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (codePoint + delta) & 0xffff;
      } else {
        glyph = cmap.readUInt16BE(
          rangeOffsetAddress + rangeOffset + (codePoint - start) * 2,
        );
        if (glyph !== 0) {
          glyph = (glyph + delta) & 0xffff;
        }
      }
      if (glyph !== 0) {
        codePoints.add(codePoint);
      }
    }
  }
}

function addFormat12(cmap: Buffer, offset: number, codePoints: Set<number>) {
  const groupCount = cmap.readUInt32BE(offset + 12);
  for (let group = 0; group < groupCount; group += 1) {
    const record = offset + 16 + group * 12;
    const start = cmap.readUInt32BE(record);
    const end = cmap.readUInt32BE(record + 4);
    const startGlyph = cmap.readUInt32BE(record + 8);
    invariant(start <= end && end <= 0x10ffff, 'cmap group range is invalid');
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      if (startGlyph + (codePoint - start) !== 0) {
        codePoints.add(codePoint);
      }
    }
  }
}

function isUnicodeEncoding(platformId: number, encodingId: number): boolean {
  return platformId === 0 || (platformId === 3 && [1, 10].includes(encodingId));
}

export function readFontCoverage(bytes: Buffer): ReadonlySet<number> {
  invariant(bytes.length >= 12, 'font file is too short');
  const signature = bytes.readUInt32BE(0);
  invariant(
    signature === WOFF2_SIGNATURE || SFNT_VERSIONS.has(signature),
    'font must be a TrueType, OpenType or WOFF2 file',
  );
  const cmap =
    signature === WOFF2_SIGNATURE
      ? woff2CmapTable(bytes)
      : sfntCmapTable(bytes);

  const codePoints = new Set<number>();
  const subtableCount = cmap.readUInt16BE(2);
  let unicodeSubtables = 0;
  for (let index = 0; index < subtableCount; index += 1) {
    const record = 4 + index * 8;
    const platformId = cmap.readUInt16BE(record);
    const encodingId = cmap.readUInt16BE(record + 2);
    const offset = cmap.readUInt32BE(record + 4);
    if (!isUnicodeEncoding(platformId, encodingId)) {
      continue;
    }
    const format = cmap.readUInt16BE(offset);
    if (format === 4) {
      addFormat4(cmap, offset, codePoints);
      unicodeSubtables += 1;
    } else if (format === 12) {
      addFormat12(cmap, offset, codePoints);
      unicodeSubtables += 1;
    }
  }

  invariant(
    unicodeSubtables > 0,
    'font must have a Unicode cmap subtable in format 4 or 12',
  );
  return codePoints;
}

let bundledCoverage: ReadonlySet<number> | null = null;

export function bundledFontCoverage(): ReadonlySet<number> {
  if (bundledCoverage === null) {
    const union = new Set<number>();
    for (const asset of BUNDLED_FONT_ASSETS) {
      for (const codePoint of readFontCoverage(asset.buffer)) {
        union.add(codePoint);
      }
    }
    bundledCoverage = union;
  }
  return bundledCoverage;
}
