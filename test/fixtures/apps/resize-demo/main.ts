import assert from 'node:assert/strict';
import process from 'node:process';
import readline from 'node:readline';

function readTerminalSize(): { cols: number; rows: number } {
  const { columns, rows } = process.stdout;

  assert(typeof columns === 'number', 'stdout.columns must be available');
  assert(typeof rows === 'number', 'stdout.rows must be available');

  return { cols: columns, rows };
}

function printTerminalSize(): void {
  const { cols, rows } = readTerminalSize();
  process.stdout.write(`SIZE: ${String(cols)}x${String(rows)}\n`);
}

const lineReader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

process.on('SIGWINCH', () => {
  printTerminalSize();
});

lineReader.on('line', (line) => {
  if (line === 'quit') {
    process.exit(0);
  }
});

lineReader.on('close', () => {
  process.stdin.pause();
});

printTerminalSize();
