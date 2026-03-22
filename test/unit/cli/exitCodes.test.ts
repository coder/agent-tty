import { describe, expect, it } from 'vitest';

import { exitCodeForError } from '../../../src/cli/exitCodes.js';
import { ERROR_CODES } from '../../../src/protocol/errors.js';

describe('CLI exit codes', () => {
  it('maps validation errors to exit code 2', () => {
    for (const code of [
      ERROR_CODES.INVALID_SESSION_ID,
      ERROR_CODES.INVALID_DIMENSIONS,
      ERROR_CODES.INVALID_SIGNAL,
      ERROR_CODES.INVALID_KEYS,
      ERROR_CODES.INVALID_DURATION,
      ERROR_CODES.INVALID_INPUT,
    ]) {
      expect(exitCodeForError(code)).toBe(2);
    }
  });

  it('maps session lifecycle errors to their documented exit codes', () => {
    expect(exitCodeForError(ERROR_CODES.SESSION_NOT_FOUND)).toBe(3);
    expect(exitCodeForError(ERROR_CODES.SESSION_NOT_RUNNING)).toBe(4);
    expect(exitCodeForError(ERROR_CODES.SESSION_ALREADY_DESTROYED)).toBe(4);
  });

  it('maps transport and storage failures to differentiated exit codes', () => {
    expect(exitCodeForError(ERROR_CODES.HOST_TIMEOUT)).toBe(5);
    expect(exitCodeForError(ERROR_CODES.HOST_UNREACHABLE)).toBe(6);
    expect(exitCodeForError(ERROR_CODES.EXPORT_ERROR)).toBe(7);
    expect(exitCodeForError(ERROR_CODES.STORAGE_READ_ERROR)).toBe(8);
    expect(exitCodeForError(ERROR_CODES.STORAGE_WRITE_ERROR)).toBe(8);
  });

  it('falls back to exit code 1 for unmapped errors', () => {
    expect(exitCodeForError(ERROR_CODES.INTERNAL_ERROR)).toBe(1);
    expect(exitCodeForError('UNKNOWN_ERROR')).toBe(1);
  });
});
