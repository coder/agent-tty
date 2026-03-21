import assert from 'node:assert/strict';
import process from 'node:process';

const EXIT_DELAY_MS = 800;

assert(
  process.stdout.writable,
  'stdout must be writable for the crash-demo fixture',
);

process.stdout.write('CRASH DEMO START\n');
process.stdout.write('Persist this line for post-mortem replay.\n');
process.stdout.write('Crash demo will exit with code 1.\n');

setTimeout(() => {
  process.stdout.write('CRASH DEMO EXITING\n');
  process.exit(1);
}, EXIT_DELAY_MS);
