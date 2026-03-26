import assert from 'node:assert/strict';
import process from 'node:process';

const RESET = '\u001b[0m';
const CLEAR_HOME = '\u001b[2J\u001b[H';
const HOLD_OPEN_MS = 1_200;
const LABEL_WIDTH = 6;
const SAMPLE_WIDTH = 30;

assert(
  process.stdout.writable,
  'stdout must be writable for the unicode-grid fixture',
);

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function cursorPosition(row: number, column: number): string {
  return `\u001b[${String(row)};${String(column)}H`;
}

const rows = [
  { row: 4, label: 'ASCII', sample: 'Hello, World! 0123456789' },
  { row: 5, label: 'BOX', sample: '┌─┐│└┘├┤┬┴┼═║╔╗╚╝' },
  { row: 6, label: 'CJK', sample: '漢字テスト中文日本' },
  { row: 7, label: 'EMOJI', sample: '✓✗★♠♣♥♦⚡☀☁' },
  { row: 8, label: 'AMBIG', sample: 'αβγδ∑∏∫∂√∞' },
  { row: 9, label: 'NERD', sample: '  󰊢 󰈙 ' },
] as const;

for (const { label, sample } of rows) {
  assert(
    label.length <= LABEL_WIDTH,
    `unicode-grid label ${label} must fit within ${String(LABEL_WIDTH)} columns`,
  );
  assert(
    sample.length <= SAMPLE_WIDTH,
    `unicode-grid sample ${label} must fit within ${String(SAMPLE_WIDTH)} code units`,
  );
}

function renderRow(label: string, sample: string): string {
  return `| ${label.padEnd(LABEL_WIDTH, ' ')} | ${sample.padEnd(SAMPLE_WIDTH, ' ')} |`;
}

const screen = [
  `${RESET}${CLEAR_HOME}`,
  `${cursorPosition(1, 1)}UNICODE GRID FIXTURE`,
  `${cursorPosition(3, 1)}| LABEL  | SAMPLE                         |`,
  ...rows.map(
    ({ row, label, sample }) =>
      `${cursorPosition(row, 1)}${renderRow(label, sample)}`,
  ),
  `${cursorPosition(10, 1)}${RESET}UNICODE GRID COMPLETE`,
  `${cursorPosition(11, 1)}${RESET}`,
].join('');

writeStdout(screen);
setTimeout(() => {
  process.exit(0);
}, HOLD_OPEN_MS);
