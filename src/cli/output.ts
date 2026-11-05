import { writeSync } from 'node:fs';
import process from 'node:process';

import type { CommandEnvelope, CommandError } from '../protocol/envelope.js';
import type { CliError } from './errors.js';

import {
  createErrorEnvelope,
  createSuccessEnvelope,
} from '../protocol/envelope.js';
import { exitCodeForError } from './exitCodes.js';

const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|(?:[\dA-PR-TZcf-nq-uy=><~]))`,
  'g',
);

let colorEnabled = true;
let jsonEnvelopeWritten = false;

const STDOUT_FD = 1;

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, '');
}

function formatHumanText(value: string): string {
  return colorEnabled ? value : stripAnsi(value);
}

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function writeJsonEnvelope<TResult, TErrorResult = never>(
  envelope: CommandEnvelope<TResult, TErrorResult>,
): void {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  jsonEnvelopeWritten = true;
}

export function writeHumanLines(lines: readonly string[]): void {
  process.stdout.write(`${formatHumanText(lines.join('\n'))}\n`);
}

export function writeHumanErrorLines(lines: readonly string[]): void {
  process.stderr.write(`${formatHumanText(lines.join('\n'))}\n`);
}

interface SuccessOutputOptions {
  command: string;
  json: boolean;
  result: unknown;
  lines: readonly string[];
}

export function formatSuccessOutput(options: SuccessOutputOptions): string {
  if (options.json) {
    return `${JSON.stringify(createSuccessEnvelope(options.command, options.result), null, 2)}\n`;
  }

  return `${formatHumanText(options.lines.join('\n'))}\n`;
}

export function emitSuccess(options: SuccessOutputOptions): void {
  process.stdout.write(formatSuccessOutput(options));
  jsonEnvelopeWritten ||= options.json;
}

/**
 * Write to stdout synchronously, looping over partial writes and a full pipe
 * buffer (EAGAIN) so the whole payload is flushed before the caller exits the
 * process. The batch signal handler needs this: an async `process.stdout.write`
 * followed by a synchronous `process.exit` truncates anything past the OS pipe
 * buffer (~64 KiB), corrupting the very partial envelope it means to flush.
 */
export function writeStdoutSync(text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(STDOUT_FD, buffer, offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        continue;
      }
      if (code === 'EPIPE') {
        return;
      }
      throw error;
    }
  }
}

export function emitSuccessSync(options: SuccessOutputOptions): void {
  writeStdoutSync(formatSuccessOutput(options));
  jsonEnvelopeWritten ||= options.json;
}

export function emitFailure(options: {
  command: string;
  json: boolean;
  error: CommandError;
  result?: unknown;
}): void {
  if (options.json) {
    writeJsonEnvelope(
      createErrorEnvelope(options.command, options.error, options.result),
    );
    return;
  }

  process.stderr.write(
    `${formatHumanText(`${options.error.code}: ${options.error.message}`)}\n`,
  );
}

export function argvHasFlag(flag: string): boolean {
  const optionsEnd = process.argv.indexOf('--');
  return process.argv
    .slice(0, optionsEnd === -1 ? undefined : optionsEnd)
    .includes(flag);
}

export function emitCliError(
  commandName: string,
  error: CliError,
  json: boolean,
): void {
  emitFailure({
    command: commandName,
    json: json && !jsonEnvelopeWritten,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
    result: error.result,
  });
  process.exitCode = exitCodeForError(error.code);
}

export function exitAfterOutputFlush(): void {
  process.stdout.write('', () => {
    process.stderr.write('', () => {
      process.exit();
    });
  });
}
