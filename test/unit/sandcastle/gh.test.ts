import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runGhJson } from '../../../.sandcastle/lib/gh.js';

const schema = z
  .object({
    value: z.string(),
  })
  .strict();

describe('runGhJson', () => {
  it('parses JSON stdout through a schema', () => {
    expect(
      runGhJson(['issue', 'list'], schema, () => ({
        stdout: '{"value":"ok"}',
        stderr: '',
        status: 0,
      })),
    ).toEqual({ value: 'ok' });
  });

  it('throws with stderr when gh exits nonzero', () => {
    expect(() =>
      runGhJson(['issue', 'list'], schema, () => ({
        stdout: '',
        stderr: 'not authenticated',
        status: 1,
      })),
    ).toThrow(/not authenticated/u);
  });

  it('throws when stdout does not match the schema', () => {
    expect(() =>
      runGhJson(['issue', 'list'], schema, () => ({
        stdout: '{"value":1}',
        stderr: '',
        status: 0,
      })),
    ).toThrow();
  });
});
