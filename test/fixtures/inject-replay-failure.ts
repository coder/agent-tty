import { appendFileSync } from 'node:fs';
import process from 'node:process';

// Makes every ghostty-web replay of the process fail, and counts the calls
// that the host makes to its renderer. It runs in the host and in a CLI
// process alike.
//   AGENT_TTY_TEST_RENDER_CALL_LOG=<file>  appends one line to the file for
//     each `HostRendererManager.withBackend` call, before it runs. A render
//     poll of `wait` is one call.
//   AGENT_TTY_TEST_REPLAY_FAILURE=crash  rejects each `replayTo` and
//     `replayWithTiming` call with the error of a crashed page
//     (`GhosttyWebCrashedError`).
//   AGENT_TTY_TEST_REPLAY_FAILURE=plain  rejects each of those calls with the
//     error that Playwright gives for a thrown RangeError: the cause on the
//     first line, then the stack frames.
// Without them a call runs as it does without the fixture.
const { register } = await import('tsx/esm/api');
register();
const { GhosttyWebBackend, GhosttyWebCrashedError } =
  await import('../../src/renderer/ghosttyWeb/index.js');
const { HostRendererManager } = await import('../../src/host/renderer.js');

const callLog = process.env.AGENT_TTY_TEST_RENDER_CALL_LOG;
const failure = process.env.AGENT_TTY_TEST_REPLAY_FAILURE;

if (callLog !== undefined) {
  // oxlint-disable-next-line typescript/unbound-method -- the patch below calls it with original.apply(this, ...).
  const original = HostRendererManager.prototype.withBackend;
  HostRendererManager.prototype.withBackend = function (
    this: unknown,
    ...args: unknown[]
  ) {
    appendFileSync(callLog, 'withBackend\n');
    return (original as (...rest: unknown[]) => unknown).apply(this, args);
  } as typeof original;
}

function replayFailure(): Error {
  if (failure === 'crash') {
    return new GhosttyWebCrashedError(
      new Error('page.evaluate: Target crashed '),
    );
  }
  return new Error(
    [
      'page.evaluate: RangeError: offset is out of bounds',
      '    at Terminal.write (http://127.0.0.1:1/assets/ghostty-web.js:1:1)',
      '    at writeBatch (http://127.0.0.1:1/index.html:2:2)',
    ].join('\n'),
  );
}

if (failure === 'crash' || failure === 'plain') {
  for (const method of ['replayTo', 'replayWithTiming'] as const) {
    GhosttyWebBackend.prototype[method] = (() =>
      Promise.reject(replayFailure())) as never;
  }
}
