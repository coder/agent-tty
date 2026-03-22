import assert from 'node:assert/strict';
import process from 'node:process';

const ENTER_ALT_SCREEN = '\u001b[?1049h';
const EXIT_ALT_SCREEN = '\u001b[?1049l';
const CLEAR_SCREEN_AND_HOME = '\u001b[2J\u001b[H';
const EXIT_DELAY_MS = 500;

assert(
  process.stdout.writable,
  'stdout must be writable for the alt-screen fixture',
);
assert(
  process.stdin.readable,
  'stdin must be readable for the alt-screen fixture',
);

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function waitForInput(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      resolve();
    });
  });
}

async function main(): Promise<void> {
  writeStdout('MAIN SCREEN READY\n');
  writeStdout('Main buffer should be restored after alt-screen exit.\n');

  await waitForInput();

  writeStdout(ENTER_ALT_SCREEN);
  writeStdout(CLEAR_SCREEN_AND_HOME);
  writeStdout('ALT SCREEN ACTIVE\n');
  writeStdout('Alternate buffer content should only appear here.\n');

  await waitForInput();

  writeStdout(EXIT_ALT_SCREEN);
  writeStdout('BACK ON MAIN SCREEN\n');
  writeStdout('Alt-screen replay complete.\n');

  setTimeout(() => {
    process.exit(0);
  }, EXIT_DELAY_MS);
}

void main();
