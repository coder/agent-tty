import { describe, expect, it } from 'vitest';

import {
  hasNestedQuantifiers,
  MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH,
  safeRegexExec,
} from '../../../src/host/hostMain.js';

describe('hasNestedQuantifiers', () => {
  it('rejects regex patterns with nested quantifiers', () => {
    expect(hasNestedQuantifiers('(a+)+')).toBe(true);
    expect(hasNestedQuantifiers('(a*)+')).toBe(true);
    expect(hasNestedQuantifiers('(a+)*')).toBe(true);
    expect(hasNestedQuantifiers('(a?){2}')).toBe(true);
    expect(hasNestedQuantifiers('(.*)+')).toBe(true);
    expect(hasNestedQuantifiers('([^)]*)+')).toBe(true);
  });

  it('allows regex patterns without nested quantifiers', () => {
    expect(hasNestedQuantifiers('a+')).toBe(false);
    expect(hasNestedQuantifiers('(abc)+')).toBe(false);
    expect(hasNestedQuantifiers('\\d{3}')).toBe(false);
    expect(hasNestedQuantifiers('[a-z]+')).toBe(false);
    expect(hasNestedQuantifiers('(a|b)+')).toBe(false);
  });
});

describe('safeRegexExec', () => {
  it('searches the full text under 50KB and truncates longer text to the first 50KB', () => {
    const underLimitText = `${'a'.repeat(100)}Z`;
    const withinLimitBoundaryText = `${'a'.repeat(MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH - 1)}Z`;
    const beyondLimitBoundaryText = `${'a'.repeat(MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH + 1)}Z`;

    expect(safeRegexExec(/Z/u, underLimitText)?.index).toBe(100);
    expect(safeRegexExec(/Z/u, withinLimitBoundaryText)?.index).toBe(
      MAX_WAIT_FOR_RENDER_REGEX_TEXT_LENGTH - 1,
    );
    expect(safeRegexExec(/Z/u, beyondLimitBoundaryText)).toBeNull();
  });
});
