import { z } from 'zod';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';
import { parseValidatedResult } from '../../../src/protocol/validation.js';

describe('parseValidatedResult', () => {
  const ResultSchema = z
    .object({
      id: z.string().min(1),
      count: z.number().int().positive(),
    })
    .strict();

  it('returns parsed data on success', () => {
    expect(
      parseValidatedResult(ResultSchema, { id: 'result-01', count: 2 }, 'bad'),
    ).toEqual({ id: 'result-01', count: 2 });
  });

  it('throws PROTOCOL_ERROR with zod issues by default', () => {
    expect(() =>
      parseValidatedResult(ResultSchema, { id: '', count: 0 }, 'invalid'),
    ).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.PROTOCOL_ERROR,
        message: 'invalid',
        details: { issues: expect.any(Array) as unknown },
      }) as object,
    );
  });

  it('uses a supplied error code', () => {
    expect(() =>
      parseValidatedResult(
        ResultSchema,
        {},
        'invalid input',
        ERROR_CODES.INVALID_INPUT,
      ),
    ).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.INVALID_INPUT,
        message: 'invalid input',
      }) as object,
    );
  });
});
