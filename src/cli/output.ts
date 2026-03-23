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

export function emitSuccess(options: {
  command: string;
  json: boolean;
  result: unknown;
  lines: readonly string[];
}): void {
  if (options.json) {
    writeJsonEnvelope(createSuccessEnvelope(options.command, options.result));
    return;
  }

  writeHumanLines(options.lines);
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
