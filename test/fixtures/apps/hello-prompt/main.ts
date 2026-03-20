import assert from 'node:assert/strict';
import process from 'node:process';
import readline from 'node:readline';

const READY_PROMPT = 'READY> ';
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const EXIT_CODE_PREFIX = 'exit-code ';

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function printReadyPrompt(): void {
  writeStdout(READY_PROMPT);
}

function normalizeInput(input: string): string {
  return input
    .replaceAll(BRACKETED_PASTE_START, '')
    .replaceAll(BRACKETED_PASTE_END, '');
}

function parseExitCode(input: string): number {
  const rawCode = input.slice(EXIT_CODE_PREFIX.length).trim();
  const exitCode = Number.parseInt(rawCode, 10);

  assert(rawCode.length > 0, 'exit-code command requires a numeric argument');
  assert(
    Number.isInteger(exitCode),
    'exit-code command must parse to an integer',
  );
  assert(
    String(exitCode) === rawCode,
    'exit-code command only accepts canonical integers',
  );

  return exitCode;
}

const lineReader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

process.on('SIGINT', () => {
  writeStdout('INTERRUPTED\n');
  process.exit(130);
});

lineReader.on('line', (line) => {
  const normalizedLine = normalizeInput(line);

  if (normalizedLine === 'exit') {
    writeStdout('BYE\n');
    process.exit(0);
  }

  if (normalizedLine.startsWith(EXIT_CODE_PREFIX)) {
    process.exit(parseExitCode(normalizedLine));
  }

  writeStdout(`ECHO: ${normalizedLine}\n`);
  printReadyPrompt();
});

lineReader.on('close', () => {
  process.stdin.pause();
});

printReadyPrompt();
