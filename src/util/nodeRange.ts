import { invariant } from './assert.js';

type VersionParts = readonly [number, number, number];

interface Comparator {
  operator: '>=' | '<';
  bound: VersionParts;
}

const COMPARATOR_PATTERN = /^(>=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u;

function parseVersion(version: string): VersionParts {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  invariant(match !== null, `Node version "${version}" must start with x.y.z`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// A missing part reads as 0, which is only correct for `>=` and `<`.
function parseComparator(comparator: string, range: string): Comparator {
  const match = COMPARATOR_PATTERN.exec(comparator);
  invariant(
    match !== null,
    `unsupported Node range comparator "${comparator}" in "${range}"`,
  );
  return {
    operator: match[1] === '>=' ? '>=' : '<',
    bound: [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)],
  };
}

function compareVersions(left: VersionParts, right: VersionParts): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function satisfiesNodeRange(version: string, range: string): boolean {
  const comparators = range
    .trim()
    .split(/\s+/u)
    .map((comparator) => parseComparator(comparator, range));
  const actual = parseVersion(version);

  return comparators.every(({ operator, bound }) => {
    const order = compareVersions(actual, bound);
    return operator === '>=' ? order >= 0 : order < 0;
  });
}
