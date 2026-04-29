import { describe, expect, it } from 'vitest';

import { MAX_CONSECUTIVE_POLL_FAILURES } from '../../../src/host/hostMain.js';

describe('waitForRender polling limits', () => {
  it('exports the consecutive renderer failure cap', () => {
    expect(MAX_CONSECUTIVE_POLL_FAILURES).toBe(10);
  });
});
