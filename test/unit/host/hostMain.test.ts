import { describe, expect, it } from 'vitest';

import { hasNestedQuantifiers } from '../../../src/host/hostMain.js';

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
