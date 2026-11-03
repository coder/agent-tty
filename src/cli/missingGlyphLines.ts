interface GlyphCheckFields {
  missingGlyphs?: readonly { codePoint: string }[] | undefined;
  missingGlyphsTruncated?: true | undefined;
}

export function missingGlyphLines(result: GlyphCheckFields): string[] {
  const lines: string[] = [];
  const codePoints = (result.missingGlyphs ?? []).map(
    (glyph) => glyph.codePoint,
  );
  if (codePoints.length > 0) {
    lines.push(`Missing glyphs (drawn as boxes): ${codePoints.join(', ')}`);
  }
  if (result.missingGlyphsTruncated === true) {
    lines.push('Glyph check incomplete');
  }
  return lines;
}
