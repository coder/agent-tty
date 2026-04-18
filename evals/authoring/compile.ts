import type { ZodType } from 'zod';

import { invariant } from '../../src/util/assert.js';
import type { EvalLane } from '../lib/types.js';

export type AuthoringPath = string | readonly PropertyKey[];
export type PatternInput = RegExp | string;

export function formatAuthoringPath(path: AuthoringPath): string {
  if (typeof path === 'string') {
    return path.length === 0 ? '<root>' : path;
  }

  return path.length === 0 ? '<root>' : path.map((segment) => String(segment)).join('.');
}

export function toPatternSource(pattern: PatternInput): string {
  return pattern instanceof RegExp
    ? `/${pattern.source}/${pattern.flags}`
    : pattern;
}

export function createCaseError(
  lane: EvalLane,
  caseId: string,
  path: AuthoringPath,
  message: string,
  cause?: unknown,
): Error {
  const formattedPath = formatAuthoringPath(path);
  const errorMessage = `Invalid ${lane} case "${caseId}" at ${formattedPath}: ${message}`;
  return cause === undefined
    ? new Error(errorMessage)
    : new Error(errorMessage, { cause });
}

export function failCase(
  lane: EvalLane,
  caseId: string,
  path: AuthoringPath,
  message: string,
  cause?: unknown,
): never {
  throw createCaseError(lane, caseId, path, message, cause);
}

export function assertCase(
  condition: unknown,
  lane: EvalLane,
  caseId: string,
  path: AuthoringPath,
  message: string,
): asserts condition {
  if (!condition) {
    failCase(lane, caseId, path, message);
  }
}

export function assertDefined<T>(
  value: T | undefined,
  lane: EvalLane,
  caseId: string,
  path: AuthoringPath,
  message: string,
): T {
  if (value === undefined) {
    failCase(lane, caseId, path, message);
  }

  return value;
}

export function assertNonEmptyArray<T>(
  values: readonly T[],
  lane: EvalLane,
  caseId: string,
  path: AuthoringPath,
  message: string,
): readonly T[] {
  if (values.length === 0) {
    failCase(lane, caseId, path, message);
  }

  return values;
}

export function assertUniqueId(
  seen: Set<string>,
  id: string,
  lane: EvalLane,
  caseId: string,
  path: AuthoringPath,
  label: string,
): void {
  assertCase(
    !seen.has(id),
    lane,
    caseId,
    path,
    `Duplicate ${label} "${id}"`,
  );
  seen.add(id);
}

export function cloneValue<T>(
  value: T,
  lane: EvalLane,
  caseId: string,
  path: AuthoringPath,
): T {
  try {
    return structuredClone(value);
  } catch (error: unknown) {
    failCase(
      lane,
      caseId,
      path,
      'Builder state could not be cloned into a fresh runtime object',
      error,
    );
  }
}

function summarizeIssues(
  issues: readonly {
    path: readonly PropertyKey[];
    message: string;
  }[],
): string {
  return issues
    .map((issue) => `${formatAuthoringPath(issue.path)}: ${issue.message}`)
    .join('; ');
}

export function compileAndValidate<T>(
  lane: EvalLane,
  caseId: string,
  schema: ZodType,
  compiled: T,
): T {
  const parsed = schema.safeParse(compiled);
  if (parsed.success) {
    return compiled;
  }

  const [firstIssue, ...restIssues] = parsed.error.issues;
  invariant(
    firstIssue !== undefined,
    `safeParse() failed for ${lane} case ${caseId} without issues`,
  );

  const restMessage =
    restIssues.length === 0 ? '' : `; ${summarizeIssues(restIssues)}`;
  throw createCaseError(
    lane,
    caseId,
    firstIssue.path,
    `${firstIssue.message}${restMessage}`,
    parsed.error,
  );
}
