import { writeSync } from 'node:fs';
import process from 'node:process';

import type { CommandEnvelope, CommandError } from '../protocol/envelope.js';
import {
  createErrorEnvelope,
  createSuccessEnvelope,
} from '../protocol/envelope.js';

const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|(?:[\dA-PR-TZcf-nq-uy=><~]))`,
  'g',
);

let colorEnabled = true;

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

export function writeJsonEnvelope<TResult>(
  envelope: CommandEnvelope<TResult>,
): void {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

export function writeHumanLines(lines: readonly string[]): void {
  process.stdout.write(`${formatHumanText(lines.join('\n'))}\n`);
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
}

export function emitFailure(options: {
  command: string;
  json: boolean;
  error: CommandError;
}): void {
  if (options.json) {
    writeJsonEnvelope(createErrorEnvelope(options.command, options.error));
    return;
  }

  process.stderr.write(
    `${formatHumanText(`${options.error.code}: ${options.error.message}`)}\n`,
  );
}
