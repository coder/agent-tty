import process from 'node:process';

// Makes the ghostty-web backend of the host replay as slowly as it did when it
// took 21 ms for each event: every `replayTo` first waits
// AGENT_TTY_TEST_REPLAY_MS_PER_EVENT ms for each event that it will replay.
// With AGENT_TTY_TEST_REPLAY_STALL_AFTER_CALLS=n, the call after the first n
// calls never ends.
if (process.argv.includes('_host')) {
  const { register } = await import('tsx/esm/api');
  register();
  const { GhosttyWebBackend } =
    await import('../../src/renderer/ghosttyWeb/backend.js');
  const msPerEvent = Number(
    process.env.AGENT_TTY_TEST_REPLAY_MS_PER_EVENT ?? '0',
  );
  const stallAfterCalls = Number(
    process.env.AGENT_TTY_TEST_REPLAY_STALL_AFTER_CALLS ?? 'Infinity',
  );
  // oxlint-disable-next-line typescript/unbound-method -- the patch below calls it with replayTo.call(this, ...).
  const replayTo = GhosttyWebBackend.prototype.replayTo;
  let calls = 0;
  GhosttyWebBackend.prototype.replayTo = async function (
    this: { lastAppliedSeq: number },
    input: Parameters<typeof replayTo>[0],
  ) {
    calls += 1;
    if (calls > stallAfterCalls) {
      await new Promise<never>(() => undefined);
    }
    const pending = input.events.filter(
      (event) =>
        event.seq > this.lastAppliedSeq && event.seq <= input.targetSeq,
    ).length;
    await new Promise((resolve) => setTimeout(resolve, pending * msPerEvent));
    return replayTo.call(this as never, input);
  } as typeof replayTo;
}
