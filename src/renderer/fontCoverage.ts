import { brotliDecompressSync } from 'node:zlib';

import { invariant } from '../util/assert.js';
import type { RenderProfileConfig } from './types.js';
import {
  BUNDLED_FONT_FAMILY,
  getBundledFontAssetByIdentity,
} from './bundledFont.js';

const WOFF2_SIGNATURE = 0x774f4632;
const WOFF2_HEADER_SIZE = 48;
const WOFF2_CUSTOM_TAG_INDEX = 63;
const WOFF2_GLYF_TAG_INDEX = 10;
const WOFF2_LOCA_TAG_INDEX = 11;
const WOFF2_KNOWN_TAG_INDEXES = { cmap: 0, name: 5 } as const;
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565]);
const POSTSCRIPT_NAME_ID = 6;

type TableTag = keyof typeof WOFF2_KNOWN_TAG_INDEXES;
type ReadTable = (tag: TableTag) => Buffer;

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

function woff2Tables(bytes: Buffer): ReadTable {
  const tableCount = bytes.readUInt16BE(12);
  const compressedSize = bytes.readUInt32BE(20);
  const cursor = { offset: WOFF2_HEADER_SIZE };
  let streamOffset = 0;
  const tables = new Map<
    number,
    { offset: number; length: number; transformed: boolean }
  >();
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
    if (tagIndex !== WOFF2_CUSTOM_TAG_INDEX) {
      tables.set(tagIndex, {
        offset: streamOffset,
        length: storedLength,
        transformed,
      });
    }
    streamOffset += storedLength;
  }

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
  return (tag) => {
    const table = tables.get(WOFF2_KNOWN_TAG_INDEXES[tag]);
    invariant(table !== undefined, `WOFF2 font has no ${tag} table`);
    invariant(!table.transformed, `WOFF2 ${tag} table must not be transformed`);
    return stream.subarray(table.offset, table.offset + table.length);
  };
}

function sfntTables(bytes: Buffer): ReadTable {
  const tableCount = bytes.readUInt16BE(4);
  return (tag) => {
    for (let table = 0; table < tableCount; table += 1) {
      const record = 12 + table * 16;
      if (bytes.toString('latin1', record, record + 4) === tag) {
        const offset = bytes.readUInt32BE(record + 8);
        const length = bytes.readUInt32BE(record + 12);
        invariant(offset + length <= bytes.length, `sfnt ${tag} is truncated`);
        return bytes.subarray(offset, offset + length);
      }
    }
    throw new Error(`sfnt font has no ${tag} table`);
  };
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

function readCoverage(cmap: Buffer): ReadonlySet<number> {
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

function readPostScriptName(name: Buffer): string {
  const count = name.readUInt16BE(2);
  const storageOffset = name.readUInt16BE(4);
  let macintoshName: string | undefined;
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    if (name.readUInt16BE(record + 6) !== POSTSCRIPT_NAME_ID) {
      continue;
    }
    const platformId = name.readUInt16BE(record);
    const encodingId = name.readUInt16BE(record + 2);
    const isWindowsUnicode = platformId === 3 && encodingId === 1;
    const isMacintoshRoman = platformId === 1 && encodingId === 0;
    const length = name.readUInt16BE(record + 8);
    const start = storageOffset + name.readUInt16BE(record + 10);
    invariant(start + length <= name.length, 'font name string is truncated');
    const text = name.subarray(start, start + length);
    if (isWindowsUnicode) {
      invariant(length % 2 === 0, 'a UTF-16 font name has an even length');
      return Buffer.from(text).swap16().toString('utf16le');
    }
    if (isMacintoshRoman) {
      macintoshName ??= text.toString('latin1');
    }
  }
  invariant(
    macintoshName !== undefined,
    'font must have a Windows Unicode or Macintosh Roman PostScript name',
  );
  return macintoshName;
}

export interface FontFile {
  postScriptName: string;
  coverage: ReadonlySet<number>;
}

export function readFontFile(bytes: Buffer): FontFile {
  invariant(bytes.length >= 12, 'font file is too short');
  const signature = bytes.readUInt32BE(0);
  invariant(
    signature === WOFF2_SIGNATURE || SFNT_VERSIONS.has(signature),
    'font must be a TrueType, OpenType or WOFF2 file',
  );
  const table =
    signature === WOFF2_SIGNATURE ? woff2Tables(bytes) : sfntTables(bytes);
  const postScriptName = readPostScriptName(table('name'));
  invariant(
    postScriptName.length > 0,
    'font PostScript name must not be empty',
  );
  return { postScriptName, coverage: readCoverage(table('cmap')) };
}

export type BundledFace = FontFile;
export type FamilyFaces = readonly [BundledFace, ...BundledFace[]];
/** The bundled families of a font stack, in stack order. Host and generic families have no entry. */
export type StackFaces = readonly [FamilyFaces, ...FamilyFaces[]];

const fontFileByIdentity = new Map<string, FontFile>();

function bundledFontFile(assetIdentity: string): FontFile {
  let fontFile = fontFileByIdentity.get(assetIdentity);
  if (fontFile === undefined) {
    const asset = getBundledFontAssetByIdentity(assetIdentity);
    invariant(asset !== undefined, 'profile font must be a bundled asset');
    fontFile = readFontFile(asset.buffer);
    fontFileByIdentity.set(assetIdentity, fontFile);
  }
  return fontFile;
}

// CSS matches font family names case-insensitively, so the keys are lower case.
function stackFamilies(fontFamily: string): string[] {
  return fontFamily.split(',').map((family) =>
    family
      .trim()
      .replace(/^(["'])(.*)\1$/u, '$2')
      .toLowerCase(),
  );
}

/**
 * The bundled faces of the families that the profile's font stack names, or
 * null when the stack does not start with a bundled family. Only a bundled
 * first family lets a screenshot tell a `.notdef` box from a host font's glyph.
 */
export function profileFaces(profile: RenderProfileConfig): StackFaces | null {
  const fonts =
    profile.fontAssets ??
    (profile.fontAssetIdentity === undefined
      ? []
      : [
          {
            family: BUNDLED_FONT_FAMILY,
            assetIdentity: profile.fontAssetIdentity,
          },
        ]);
  const stack: FamilyFaces[] = [];
  for (const family of new Set(stackFamilies(profile.fontFamily))) {
    const [first, ...rest] = fonts
      .filter((font) => font.family.toLowerCase() === family)
      .map((font) => bundledFontFile(font.assetIdentity));
    if (first !== undefined) {
      stack.push([first, ...rest]);
    } else if (stack.length === 0) {
      return null;
    }
  }
  const [firstFamily, ...otherFamilies] = stack;
  invariant(firstFamily !== undefined, 'a font stack names a family');
  const postScriptNames = stack.flat().map((face) => face.postScriptName);
  invariant(
    new Set(postScriptNames).size === postScriptNames.length,
    'CDP names a face by its PostScript name, so the names must be distinct',
  );
  return [firstFamily, ...otherFamilies];
}
