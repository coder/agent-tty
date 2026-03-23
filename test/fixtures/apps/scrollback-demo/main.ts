import assert from 'node:assert/strict';
import process from 'node:process';

const HOLD_OPEN_MS = 1_200;
const LINE_SUFFIX = 'abcdefghijklmnopqrstuvwxyz';
const LINE_COUNT = 80;

assert(
  process.stdout.writable,
  'stdout must be writable for the scrollback-demo fixture',
);

process.stdout.write('SCROLLBACK DEMO START\n');

for (let i = 1; i <= LINE_COUNT; i += 1) {
  process.stdout.write(`LINE ${String(i).padStart(3, '0')} | ${LINE_SUFFIX}\n`);
}

process.stdout.write('SCROLLBACK COMPLETE\n');

setTimeout(() => {
  process.exit(0);
}, HOLD_OPEN_MS);
