// Preload (`--import`) for the session host only: right after node-pty
// spawns the program, the host sends itself SIGTERM, as a create that gives
// up can while the host runs its synchronous start-up block. The program's
// pid goes to $SIGTERM_AFTER_SPAWN_PID_FILE.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

if (process.argv.includes('_host')) {
  const pidFile = process.env.SIGTERM_AFTER_SPAWN_PID_FILE;
  if (pidFile === undefined) {
    throw new Error('SIGTERM_AFTER_SPAWN_PID_FILE must be set');
  }
  const require = createRequire(import.meta.url);
  const pty = require('node-pty') as {
    spawn: (...args: unknown[]) => { pid: number };
  };
  const spawn = pty.spawn;
  pty.spawn = (...args: unknown[]) => {
    const child = spawn(...args);
    writeFileSync(pidFile, String(child.pid));
    process.kill(process.pid, 'SIGTERM');
    return child;
  };
}
