// Replays a model trace against the real CLI by holding one file-system call
// in one agent-tty process. It changes timing only: the held call still runs
// and returns its own result. A long hold can still trip a CLI time-out.
//
//   REPLAY_HOLD='<argv word>:<call>:<path suffix>:<nth>:<ms>[,...]' \
//   NODE_OPTIONS="--import $PWD/.agents/skills/verify-session-lifecycle/scripts/replay-hold.mjs" \
//   node --import tsx src/cli/main.ts <command> ...
//
// <argv word>  a word in the process's argv: _host, gc, list, inspect, ...
// <call>       a node:fs/promises function: rename (matches the target
//              path), rm, unlink, writeFile, mkdir (hold before the call), or
//              readFile (hold after the read, so the caller gets an old copy)
// <nth>        hold the nth matching call (1 = the first) in that process
//
// The detached host inherits NODE_OPTIONS and REPLAY_HOLD from `create`.
// Set REPLAY_LOG=<file> to log each hold.
import { appendFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import process from 'node:process';

const HOLD_AFTER = new Set(['readFile']);
const HOLD_BEFORE = new Set(['rename', 'rm', 'unlink', 'writeFile', 'mkdir']);

function log(message) {
  if (process.env.REPLAY_LOG !== undefined) {
    appendFileSync(process.env.REPLAY_LOG, `${process.pid} ${message}\n`);
  }
}

const holds = (process.env.REPLAY_HOLD ?? '')
  .split(',')
  .filter((spec) => spec.length > 0)
  .map((spec) => {
    const [word, call, suffix, nth, ms] = spec.split(':');
    if (!HOLD_AFTER.has(call) && !HOLD_BEFORE.has(call)) {
      throw new Error(`REPLAY_HOLD: unsupported call ${call}`);
    }
    return { word, call, suffix, nth: Number(nth), ms: Number(ms), seen: 0 };
  })
  .filter((hold) => process.argv.includes(hold.word));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const call of new Set(holds.map((hold) => hold.call))) {
  const original = fsp[call];
  const mine = holds.filter((hold) => hold.call === call);
  fsp[call] = async (...args) => {
    const path = String(call === 'rename' ? args[1] : args[0]);
    let hold;
    for (const h of mine) {
      if (path.endsWith(h.suffix)) {
        h.seen += 1;
        if (h.seen === h.nth && hold === undefined) {
          hold = h;
        }
      }
    }
    if (hold === undefined) {
      return original(...args);
    }
    log(`hold ${call} ${path} for ${String(hold.ms)} ms`);
    if (HOLD_BEFORE.has(call)) {
      await sleep(hold.ms);
      log(`release ${call} ${path}`);
      return original(...args);
    }
    const result = await original(...args);
    await sleep(hold.ms);
    log(`release ${call} ${path}`);
    return result;
  };
}
syncBuiltinESMExports();
