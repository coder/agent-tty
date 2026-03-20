import process from 'node:process';

const CLEAR_SCREEN_AND_HOME = '\u001b[2J\u001b[H';
const FINAL_SCREEN = '3 items\nReady\n';
const HOLD_OPEN_MS = 30_000;
const TRANSITION_DELAY_MS = 1_000;

process.stdout.write('Loading...\n');

setTimeout(() => {
  process.stdout.write(CLEAR_SCREEN_AND_HOME);
  process.stdout.write(FINAL_SCREEN);
}, TRANSITION_DELAY_MS);

setTimeout(() => {
  process.stdin.resume();
}, HOLD_OPEN_MS);
