import { sha256Hex } from '../util/hash.js';

/**
 * The minimal snapshot shape needed to derive the canonical visible text: the
 * ordered visible lines, each carrying its already-decoded `text`.
 *
 * Compatible with `Pick<SemanticSnapshot, 'visibleLines'>`.
 */
interface CanonicalScreenSource {
  readonly visibleLines: ReadonlyArray<{ readonly text: string }>;
}

/**
 * The ordered canonical visible lines of a snapshot.
 *
 * The body is VERBATIM the inline expression already at hostMain.ts:904-906 and
 * matcher.ts:304-305 — no trim/pad/normalize is applied, so it is
 * behavior-preserving. The source is `visibleLines[].text` ONLY; it must NEVER
 * read `backend.getVisibleText()` (divergent native impl) or `cells[]` (the
 * dashboard's alternate source).
 */
export function canonicalVisibleLines(s: CanonicalScreenSource): string[] {
  return s.visibleLines.map((line) => line.text);
}

/**
 * The canonical visible text of a snapshot: its canonical visible lines joined
 * with `\n`. See {@link canonicalVisibleLines} for the no-normalization
 * guarantee and source constraint.
 */
export function canonicalVisibleText(s: CanonicalScreenSource): string {
  return canonicalVisibleLines(s).join('\n');
}

/**
 * The screen hash of a snapshot: the lowercase 64-character SHA-256 hex of the
 * UTF-8 bytes of its canonical visible text.
 */
export function computeScreenHash(s: CanonicalScreenSource): string {
  return sha256Hex(canonicalVisibleText(s));
}
