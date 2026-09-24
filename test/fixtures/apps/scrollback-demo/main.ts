import assert from 'node:assert/strict';
import process from 'node:process';

const HOLD_OPEN_MS = 1_200;
const LINE_SUFFIX = 'abcdefghijklmnopqrstuvwxyz';
const LINE_COUNT = 80;
// With --wait-input-before-complete, the fixture blocks until it receives any
// stdin byte before printing the completion marker. Tests that must observe
// an intermediate Event Log state first (e.g. record diff replays) use this
// handshake so the marker cannot coalesce into an earlier PTY chunk.
const waitForInput = process.argv.includes('--wait-input-before-complete');

assert(
  process.stdout.writable,
  'stdout must be writable for the scrollback-demo fixture',
);

process.stdout.write('SCROLLBACK DEMO START\n');

for (let i = 1; i <= LINE_COUNT; i += 1) {
  process.stdout.write(`LINE ${String(i).padStart(3, '0')} | ${LINE_SUFFIX}\n`);
}

function finish(): void {
  process.stdout.write('SCROLLBACK COMPLETE\n');

  setTimeout(() => {
    process.exit(0);
  }, HOLD_OPEN_MS);
}

if (waitForInput) {
  process.stdin.once('data', finish);
  process.stdin.resume();
} else {
  finish();
}
