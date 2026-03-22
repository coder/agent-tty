import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';

import { ERROR_CODES, makeCliError } from '../../protocol/errors.js';

interface ResolveCommandInputTextOptions {
  commandName: 'type' | 'paste';
  text: string | undefined;
  file: string | undefined;
}

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

function usageMessage(commandName: 'type' | 'paste'): string {
  return `Usage: agent-terminal ${commandName} <session-id> [text] [--file <path>]`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

  try {
    await access(filePath, fsConstants.F_OK);
  } catch (error: unknown) {
    throw createInvalidInputError(
      `Input file "${filePath}" was not found.`,
      {
        file: filePath,
      },
      error,
    );
  }

  try {
    await access(filePath, fsConstants.R_OK);
  } catch (error: unknown) {
    throw createInvalidInputError(
      `Input file "${filePath}" is not readable.`,
      {
        file: filePath,
      },
      error,
    );
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

    if (isErrnoException(error) && error.code === 'EISDIR') {
      throw createInvalidInputError(
        `Input file "${filePath}" must be a file, not a directory.`,
        {
          file: filePath,
        },
        error,
      );
    }

    throw createInvalidInputError(
      `Failed to read input file "${filePath}".`,
      {
        file: filePath,
      },
      error,
    );
  }
}
