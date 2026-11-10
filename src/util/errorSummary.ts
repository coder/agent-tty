export const MAX_ERROR_SUMMARY_CHARS = 300;

const ELLIPSIS = '…';

/**
 * The text of a failure for a message that a person reads: the first line of
 * the error message, with its whitespace collapsed and no stack frames, at
 * most `MAX_ERROR_SUMMARY_CHARS` characters. Playwright puts the page error on
 * the first line and its call log and the stack on the lines after it. An
 * error without a message gives its name, and a value that is not an `Error`
 * gives `String(value)`.
 */
export function summarizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .find((line) => line.length > 0);
  const summary =
    firstLine ?? (error instanceof Error ? error.name : 'unknown error');
  if (summary.length <= MAX_ERROR_SUMMARY_CHARS) {
    return summary;
  }
  const kept = summary.slice(0, MAX_ERROR_SUMMARY_CHARS - ELLIPSIS.length);
  // Do not cut a surrogate pair in half.
  const lastCode = kept.charCodeAt(kept.length - 1);
  const whole =
    lastCode >= 0xd800 && lastCode <= 0xdbff ? kept.slice(0, -1) : kept;
  return `${whole}${ELLIPSIS}`;
}
