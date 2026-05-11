import type { z } from 'zod';

import type { ProtocolErrorCode } from './errors.js';

import { ERROR_CODES, makeCliError } from './errors.js';

export function parseValidatedResult<TSchema extends z.ZodType>(
  schema: TSchema,
  rawValue: unknown,
  message: string,
  errorCode: ProtocolErrorCode = ERROR_CODES.PROTOCOL_ERROR,
): z.infer<TSchema> {
  const parsedResult = schema.safeParse(rawValue);
  if (!parsedResult.success) {
    throw makeCliError(errorCode, {
      message,
      details: { issues: parsedResult.error.issues },
    });
  }

  return parsedResult.data;
}
