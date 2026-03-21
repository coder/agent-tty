import assert from 'node:assert/strict';
import process from 'node:process';

const ENTER_ALT_SCREEN = '\u001b[?1049h';
const EXIT_ALT_SCREEN = '\u001b[?1049l';
const CLEAR_SCREEN_AND_HOME = '\u001b[2J\u001b[H';
const ENTER_ALT_MS = 2_500;
const LEAVE_ALT_MS = 4_500;
const EXIT_MS = 5_200;

assert(
  process.stdout.writable,
  'stdout must be writable for the alt-screen fixture',
);

function writeStdout(text: string): void {
  process.stdout.write(text);
}

writeStdout('MAIN SCREEN READY\n');
writeStdout('Main buffer should be restored after alt-screen exit.\n');

setTimeout(() => {
  writeStdout(ENTER_ALT_SCREEN);
  writeStdout(CLEAR_SCREEN_AND_HOME);
  writeStdout('ALT SCREEN ACTIVE\n');
  writeStdout('Alternate buffer content should only appear here.\n');
}, ENTER_ALT_MS);

setTimeout(() => {
  writeStdout(EXIT_ALT_SCREEN);
  writeStdout('BACK ON MAIN SCREEN\n');
  writeStdout('Alt-screen replay complete.\n');
}, LEAVE_ALT_MS);

setTimeout(() => {
  process.exit(0);
}, EXIT_MS);
