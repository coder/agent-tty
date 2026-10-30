// Preload (`--import`) that makes every signal to a process group fail with
// EPERM and deliver nothing, as when the group's remaining processes belong
// to another user.
import process from 'node:process';

const kill = process.kill.bind(process);

process.kill = (pid: number, signal?: string | number): true => {
  if (pid < -1) {
    throw Object.assign(new Error('kill EPERM'), {
      errno: -1,
      code: 'EPERM',
      syscall: 'kill',
    });
  }
  return kill(pid, signal);
};
