// Preload (`--import`) that holds the first event-log write of an `input_run`
// record for HOLD_INPUT_RUN_MS. It writes the hold's start and end times
// (Date.now()) to HOLD_INPUT_RUN_SIGNAL, one per line.
import { appendFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const signalPath = process.env.HOLD_INPUT_RUN_SIGNAL;
const holdMs = Number(process.env.HOLD_INPUT_RUN_MS ?? '2000');

if (signalPath !== undefined) {
  const handle = await open(process.execPath, 'r');
  const prototype = Object.getPrototypeOf(handle) as {
    appendFile: (data: unknown, options?: unknown) => Promise<void>;
  };
  await handle.close();
  const appendFile = prototype.appendFile;
  let held = false;

  prototype.appendFile = async function (
    this: unknown,
    data: unknown,
    options?: unknown,
  ): Promise<void> {
    if (
      !held &&
      typeof data === 'string' &&
      data.includes('"type":"input_run"')
    ) {
      held = true;
      appendFileSync(signalPath, `${String(Date.now())}\n`);
      await delay(holdMs);
      appendFileSync(signalPath, `${String(Date.now())}\n`);
    }
    await appendFile.call(this, data, options);
  };
}
