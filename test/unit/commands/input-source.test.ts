import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../../../src/protocol/errors.js';

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  lstat: mocks.lstat,
  stat: mocks.stat,
  readFile: mocks.readFile,
}));

import {
  MAX_INPUT_FILE_SIZE,
  resolveCommandInputText,
} from '../../../src/cli/commands/inputSource.js';

function createMockStats(options: { isFile?: boolean; size?: number } = {}) {
  return {
    isFile: vi.fn(() => options.isFile ?? true),
    size: options.size ?? 128,
  };
}

describe('resolveCommandInputText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lstat.mockResolvedValue(createMockStats());
    mocks.stat.mockResolvedValue(createMockStats());
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
    expect(mocks.lstat).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled();
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
    expect(mocks.lstat).toHaveBeenCalledWith('/tmp/input.txt');
    expect(mocks.stat).toHaveBeenCalledWith('/tmp/input.txt');
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
    mocks.lstat.mockRejectedValueOnce(error);

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
    mocks.readFile.mockRejectedValueOnce(error);

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

  it('rejects non-regular input paths', async () => {
    mocks.lstat.mockResolvedValueOnce(createMockStats({ isFile: false }));

    await expect(
      resolveCommandInputText({
        commandName: 'type',
        text: undefined,
        file: '/tmp/link.txt',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message:
        'Input file "/tmp/link.txt" must be a regular file. Directories, symlinks, and device files are not supported.',
    });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('rejects oversized input files before reading them', async () => {
    mocks.stat.mockResolvedValueOnce(
      createMockStats({ size: MAX_INPUT_FILE_SIZE + 1 }),
    );

    await expect(
      resolveCommandInputText({
        commandName: 'paste',
        text: undefined,
        file: '/tmp/huge.txt',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_INPUT,
      message:
        'Input file "/tmp/huge.txt" exceeds the 10 MB limit for --file input.',
      details: {
        file: '/tmp/huge.txt',
        sizeBytes: MAX_INPUT_FILE_SIZE + 1,
        maxSizeBytes: MAX_INPUT_FILE_SIZE,
      },
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
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
