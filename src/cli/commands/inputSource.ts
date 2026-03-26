import assert from 'node:assert/strict';
import { lstat, readFile, stat } from 'node:fs/promises';

import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';

interface ResolveCommandInputTextOptions {
  commandName: 'type' | 'paste' | 'run';
  text: string | undefined;
  file: string | undefined;
}

export const MAX_INPUT_FILE_SIZE = 10_000_000;

function createInvalidInputError(
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
) {
  return makeCliError(ERROR_CODES.INVALID_INPUT, {
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function usageMessage(commandName: 'type' | 'paste' | 'run'): string {
  return `Usage: agent-terminal ${commandName} <session-id> [text] [--file <path>]`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function createInputFileLookupError(
  filePath: string,
  error: unknown,
): ReturnType<typeof createInvalidInputError> {
  if (isErrnoException(error) && error.code === 'ENOENT') {
    return createInvalidInputError(
      `Input file "${filePath}" was not found.`,
      {
        file: filePath,
      },
      error,
    );
  }

  if (
    isErrnoException(error) &&
    ['EACCES', 'EPERM'].includes(error.code ?? '')
  ) {
    return createInvalidInputError(
      `Input file "${filePath}" is not readable.`,
      {
        file: filePath,
      },
      error,
    );
  }

  return createInvalidInputError(
    `Failed to inspect input file "${filePath}".`,
    {
      file: filePath,
    },
    error,
  );
}

function createInputFileReadError(
  filePath: string,
  error: unknown,
): ReturnType<typeof createInvalidInputError> {
  if (isErrnoException(error) && error.code === 'ENOENT') {
    return createInvalidInputError(
      `Input file "${filePath}" was not found.`,
      {
        file: filePath,
      },
      error,
    );
  }

  if (
    isErrnoException(error) &&
    ['EACCES', 'EPERM'].includes(error.code ?? '')
  ) {
    return createInvalidInputError(
      `Input file "${filePath}" is not readable.`,
      {
        file: filePath,
      },
      error,
    );
  }

  if (isErrnoException(error) && error.code === 'EISDIR') {
    return createInvalidInputError(
      `Input file "${filePath}" must be a regular file. Directories, symlinks, and device files are not supported.`,
      {
        file: filePath,
      },
      error,
    );
  }

  return createInvalidInputError(
    `Failed to read input file "${filePath}".`,
    {
      file: filePath,
    },
    error,
  );
}

export async function resolveCommandInputText(
  options: ResolveCommandInputTextOptions,
): Promise<string> {
  assert(
    options.commandName.length > 0,
    'commandName must be a non-empty string',
  );

  if (options.text !== undefined && options.file !== undefined) {
    throw createInvalidInputError(
      `Positional <text> argument and --file are mutually exclusive. ${usageMessage(options.commandName)}`,
      {
        text: options.text,
        file: options.file,
      },
    );
  }

  if (options.text === undefined && options.file === undefined) {
    throw createInvalidInputError(
      `Missing input text. Provide either a positional <text> argument or --file <path>. ${usageMessage(options.commandName)}`,
    );
  }

  if (options.text !== undefined) {
    if (options.text.length === 0) {
      throw createInvalidInputError('Text must not be empty.', {
        text: options.text,
      });
    }

    return options.text;
  }

  const filePath = options.file;
  assert(typeof filePath === 'string', '--file must resolve to a string path');
  assert(filePath.length > 0, '--file path must be a non-empty string');

  let fileStats: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStats = await lstat(filePath);
  } catch (error: unknown) {
    throw createInputFileLookupError(filePath, error);
  }

  if (!fileStats.isFile()) {
    throw createInvalidInputError(
      `Input file "${filePath}" must be a regular file. Directories, symlinks, and device files are not supported.`,
      {
        file: filePath,
      },
    );
  }

  try {
    const contentStats = await stat(filePath);
    if (contentStats.size > MAX_INPUT_FILE_SIZE) {
      throw createInvalidInputError(
        `Input file "${filePath}" exceeds the 10 MB limit for --file input.`,
        {
          file: filePath,
          sizeBytes: contentStats.size,
          maxSizeBytes: MAX_INPUT_FILE_SIZE,
        },
      );
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'CliError') {
      throw error;
    }

    throw createInputFileLookupError(filePath, error);
  }

  try {
    const content = await readFile(filePath, 'utf8');
    assert(
      typeof content === 'string',
      'readFile(filePath, utf8) must return a string',
    );

    if (content.length === 0) {
      throw createInvalidInputError(
        `Input file "${filePath}" must not be empty.`,
        {
          file: filePath,
        },
      );
    }

    return content;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'CliError') {
      throw error;
    }

    throw createInputFileReadError(filePath, error);
  }
}
