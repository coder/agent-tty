import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  readFile: mocks.readFile,
}));

import { resolveCommandInputText } from '../../../src/cli/commands/inputSource.js';

describe('resolveCommandInputText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue('from-file');
  });

  it('returns positional text when provided without --file', async () => {
    await expect(
      resolveCommandInputText({
        commandName: 'type',
        text: 'inline-text',
        file: undefined,
      }),
    ).resolves.toBe('inline-text');
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('reads text from a file when --file is provided', async () => {
    await expect(
      resolveCommandInputText({
        commandName: 'paste',
        text: undefined,
        file: '/tmp/input.txt',
      }),
    ).resolves.toBe('from-file');
    expect(mocks.access).toHaveBeenNthCalledWith(1, '/tmp/input.txt', 0);
    expect(mocks.access).toHaveBeenNthCalledWith(2, '/tmp/input.txt', 4);
    expect(mocks.readFile).toHaveBeenCalledWith('/tmp/input.txt', 'utf8');
  });

  it('rejects mixing positional text and --file', async () => {
    const result = resolveCommandInputText({
      commandName: 'type',
      text: 'inline-text',
      file: '/tmp/input.txt',
    });

    await expect(result).rejects.toHaveProperty(
      'code',
      ERROR_CODES.INVALID_INPUT,
    );
    await expect(result).rejects.toThrow(/mutually exclusive/);
  });

  it('rejects missing text and --file', async () => {
    const result = resolveCommandInputText({
      commandName: 'paste',
      text: undefined,
      file: undefined,
    });

    await expect(result).rejects.toHaveProperty(
      'code',
      ERROR_CODES.INVALID_INPUT,
    );
    await expect(result).rejects.toThrow(
      /Provide either a positional <text> argument or --file <path>/,
    );
  });

  it('rejects a missing input file', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    mocks.access.mockRejectedValueOnce(error);

    await expect(
      resolveCommandInputText({
        commandName: 'type',
        text: undefined,
        file: '/tmp/missing.txt',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'Input file "/tmp/missing.txt" was not found.',
    });
  });

  it('rejects an unreadable input file', async () => {
    const error = Object.assign(new Error('unreadable'), { code: 'EACCES' });
    mocks.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);

    await expect(
      resolveCommandInputText({
        commandName: 'paste',
        text: undefined,
        file: '/tmp/protected.txt',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'Input file "/tmp/protected.txt" is not readable.',
    });
  });

  it('rejects an empty input file', async () => {
    mocks.readFile.mockResolvedValue('');

    await expect(
      resolveCommandInputText({
        commandName: 'type',
        text: undefined,
        file: '/tmp/empty.txt',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message: 'Input file "/tmp/empty.txt" must not be empty.',
    });
  });
});
