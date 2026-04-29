import type { WaitForRenderParams } from '../protocol/messages.js';
import type { SemanticSnapshot } from '../renderer/types.js';

import { ERROR_CODES, makeCliError } from '../protocol/errors.js';
import { invariant } from '../util/assert.js';
import {
  MAX_WAIT_FOR_RENDER_REGEX_LENGTH,
  MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH,
  MAX_WAIT_FOR_RENDER_TEXT_LENGTH,
} from './limits.js';

export {
  MAX_WAIT_FOR_RENDER_REGEX_LENGTH,
  MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH,
  MAX_WAIT_FOR_RENDER_TEXT_LENGTH,
} from './limits.js';

const BRACED_QUANTIFIER_PATTERN = /^\{(?:\d+|\d+,\d*)\}/;
const NESTED_QUANTIFIER_MESSAGE =
  'Regex pattern contains nested quantifiers which may cause catastrophic backtracking. Simplify the pattern.';

type RenderWaitCondition = Pick<
  WaitForRenderParams,
  'text' | 'regex' | 'screenStableMs' | 'cursorRow' | 'cursorCol'
>;

export interface PreparedRenderWaitCondition extends RenderWaitCondition {
  readonly compiledRegex?: RegExp;
}

interface RenderWaitSnapshotMatch {
  readonly matched: boolean;
  readonly textMatched: boolean;
  readonly cursorMatched: boolean;
  readonly stabilityMatched: boolean;
  readonly contentAndCursorMatched: boolean;
  readonly matchedText?: string;
  readonly cursorRow: number;
  readonly cursorCol: number;
  readonly capturedAtSeq: number;
  readonly visibleLines: string[];
}

interface MatchOptions {
  readonly stableForMs?: number;
}

function isRegexQuantifierAt(pattern: string, index: number): boolean {
  const nextChar = pattern[index];
  if (nextChar === '*' || nextChar === '+' || nextChar === '?') {
    return true;
  }

  if (nextChar !== '{') {
    return false;
  }

  return BRACED_QUANTIFIER_PATTERN.test(pattern.slice(index));
}

/**
 * Reject regex patterns with obvious ReDoS-prone constructs:
 * - Nested quantifiers: (x+)+, (x*)+, (x+)*, (x?){n}, etc.
 * - Star-height > 1 patterns
 *
 * This is a heuristic check, not a full regex analysis.
 * It catches the most common catastrophic backtracking patterns.
 */
export function hasNestedQuantifiers(pattern: string): boolean {
  invariant(typeof pattern === 'string', 'regex pattern must be a string');

  const groupHasQuantifierStack: boolean[] = [];
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    invariant(char !== undefined, 'regex pattern character must exist');

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === '[') {
      inCharacterClass = true;
      continue;
    }

    if (char === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }

    if (inCharacterClass) {
      continue;
    }

    if (char === '(') {
      groupHasQuantifierStack.push(false);
      continue;
    }

    if (char === ')') {
      const groupHasQuantifier = groupHasQuantifierStack.pop() ?? false;
      const groupIsQuantified = isRegexQuantifierAt(pattern, index + 1);
      if (groupHasQuantifier && groupIsQuantified) {
        return true;
      }

      const parentGroupIndex = groupHasQuantifierStack.length - 1;
      if (parentGroupIndex >= 0 && (groupHasQuantifier || groupIsQuantified)) {
        groupHasQuantifierStack[parentGroupIndex] = true;
      }

      continue;
    }

    const currentGroupIndex = groupHasQuantifierStack.length - 1;
    if (currentGroupIndex < 0) {
      continue;
    }

    if (char === '*' || char === '+' || char === '?') {
      const previousChar = pattern[index - 1];
      if (previousChar !== '(') {
        groupHasQuantifierStack[currentGroupIndex] = true;
      }
      continue;
    }

    if (char === '{' && isRegexQuantifierAt(pattern, index)) {
      groupHasQuantifierStack[currentGroupIndex] = true;
    }
  }

  return false;
}

export function safeRegexExec(
  regex: RegExp,
  text: string,
): RegExpExecArray | null {
  invariant(regex instanceof RegExp, 'regex must be a RegExp');
  invariant(typeof text === 'string', 'regex input text must be a string');

  const limitedText =
    text.length > MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH
      ? text.slice(0, MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH)
      : text;
  return regex.exec(limitedText);
}

/**
 * Validate a render-wait condition and compile its regex once for repeated
 * snapshot matching. User-invalid conditions throw CliError(INVALID_INPUT).
 */
export function prepareRenderWaitCondition(
  condition: RenderWaitCondition,
): PreparedRenderWaitCondition {
  const { text, regex, screenStableMs, cursorRow, cursorCol } = condition;

  if (
    text === undefined &&
    regex === undefined &&
    screenStableMs === undefined &&
    cursorRow === undefined &&
    cursorCol === undefined
  ) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message:
        'waitForRender requires at least one of text, regex, screenStableMs, cursorRow, or cursorCol',
    });
  }

  if (text !== undefined && regex !== undefined) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'waitForRender text and regex filters are mutually exclusive',
    });
  }

  if (
    text !== undefined &&
    (text.length < 1 || text.length > MAX_WAIT_FOR_RENDER_TEXT_LENGTH)
  ) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: `Wait text must be between 1 and ${String(MAX_WAIT_FOR_RENDER_TEXT_LENGTH)} characters`,
    });
  }

  let compiledRegex: RegExp | undefined;
  if (regex !== undefined) {
    if (regex.length < 1 || regex.length > MAX_WAIT_FOR_RENDER_REGEX_LENGTH) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: `Wait regex pattern must be between 1 and ${String(MAX_WAIT_FOR_RENDER_REGEX_LENGTH)} characters`,
      });
    }

    if (hasNestedQuantifiers(regex)) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: NESTED_QUANTIFIER_MESSAGE,
      });
    }

    try {
      compiledRegex = new RegExp(regex);
    } catch (error) {
      throw makeCliError(ERROR_CODES.INVALID_INPUT, {
        message: `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
  }

  if (
    screenStableMs !== undefined &&
    (!Number.isInteger(screenStableMs) || screenStableMs <= 0)
  ) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'screenStableMs must be a positive integer',
    });
  }

  if (
    cursorRow !== undefined &&
    (!Number.isInteger(cursorRow) || cursorRow < 0)
  ) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'cursorRow must be a non-negative integer',
    });
  }

  if (
    cursorCol !== undefined &&
    (!Number.isInteger(cursorCol) || cursorCol < 0)
  ) {
    throw makeCliError(ERROR_CODES.INVALID_INPUT, {
      message: 'cursorCol must be a non-negative integer',
    });
  }

  return {
    text,
    regex,
    screenStableMs,
    cursorRow,
    cursorCol,
    ...(compiledRegex === undefined ? {} : { compiledRegex }),
  };
}

/**
 * Evaluate one SemanticSnapshot against a prepared condition without tracking
 * time internally. Omit stableForMs when elapsed screen stability cannot be
 * proven; contentAndCursorMatched lets offline fallback distinguish that from
 * content/cursor mismatches.
 */
export function matchRenderWaitSnapshot(
  condition: PreparedRenderWaitCondition,
  snapshot: SemanticSnapshot,
  options: MatchOptions = {},
): RenderWaitSnapshotMatch {
  invariant(
    condition.regex === undefined || condition.compiledRegex instanceof RegExp,
    'PreparedRenderWaitCondition with regex must have compiledRegex; use prepareRenderWaitCondition()',
  );
  invariant(
    condition.compiledRegex === undefined ||
      (!condition.compiledRegex.global && !condition.compiledRegex.sticky),
    'prepared regex must not use stateful global or sticky flags',
  );
  invariant(
    Array.isArray(snapshot.visibleLines),
    'snapshot visibleLines must exist',
  );
  invariant(
    Number.isInteger(snapshot.cursorRow) && snapshot.cursorRow >= 0,
    'snapshot cursorRow must be a non-negative integer',
  );
  invariant(
    Number.isInteger(snapshot.cursorCol) && snapshot.cursorCol >= 0,
    'snapshot cursorCol must be a non-negative integer',
  );
  invariant(
    Number.isInteger(snapshot.capturedAtSeq) && snapshot.capturedAtSeq >= 0,
    'snapshot capturedAtSeq must be a non-negative integer',
  );

  if (options.stableForMs !== undefined) {
    invariant(
      Number.isFinite(options.stableForMs) && options.stableForMs >= 0,
      'stableForMs must be a non-negative finite number when provided',
    );
  }

  const visibleLines = snapshot.visibleLines.map((line) => line.text);
  const visibleText = visibleLines.join('\n');

  let textMatched = false;
  let matchedText: string | undefined;
  if (condition.text !== undefined) {
    if (visibleText.includes(condition.text)) {
      textMatched = true;
      matchedText = condition.text;
    }
  } else if (condition.compiledRegex !== undefined) {
    const match = safeRegexExec(condition.compiledRegex, visibleText);
    if (match !== null) {
      textMatched = true;
      matchedText = match[0];
    }
  } else {
    textMatched = true;
  }

  const cursorMatched =
    (condition.cursorRow === undefined ||
      snapshot.cursorRow === condition.cursorRow) &&
    (condition.cursorCol === undefined ||
      snapshot.cursorCol === condition.cursorCol);

  const stabilityMatched =
    condition.screenStableMs === undefined ||
    (options.stableForMs !== undefined &&
      options.stableForMs >= condition.screenStableMs);
  const contentAndCursorMatched = textMatched && cursorMatched;

  return {
    matched: contentAndCursorMatched && stabilityMatched,
    textMatched,
    cursorMatched,
    stabilityMatched,
    contentAndCursorMatched,
    ...(matchedText === undefined ? {} : { matchedText }),
    cursorRow: snapshot.cursorRow,
    cursorCol: snapshot.cursorCol,
    capturedAtSeq: snapshot.capturedAtSeq,
    visibleLines,
  };
}
