// Preload (`--import`) for a `create` process: process.platform reads win32,
// and ChildProcess.kill sends SIGKILL, as TerminateProcess ends a Windows
// process at once without its handlers. The host that create spawns inherits
// NODE_OPTIONS and skips this, so it runs as a Linux host.
import { ChildProcess } from 'node:child_process';
import process from 'node:process';

if (process.argv.includes('create') && !process.argv.includes('_host')) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const kill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function killAtOnce(this: ChildProcess) {
    return kill.call(this, 'SIGKILL');
  };
}
