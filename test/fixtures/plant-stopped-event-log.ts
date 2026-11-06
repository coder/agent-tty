// Preload (`--import`) for a `create` process. The host starts on an event log
// that holds one output record and the record that stops the log, as a host
// leaves behind a log that reached its limit. The host reopens that log
// stopped, so it records nothing that the program prints. Only the host runs
// this.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const hostIndex = process.argv.indexOf('_host');
if (hostIndex !== -1) {
  const home = process.env.AGENT_TTY_HOME;
  const sessionId = process.argv[hostIndex + 1];
  if (home === undefined || sessionId === undefined) {
    throw new Error('the host needs AGENT_TTY_HOME and a session id');
  }
  const record = (seq: number, type: string, payload: object): string =>
    `${JSON.stringify({ seq, ts: new Date().toISOString(), type, payload })}\n`;
  writeFileSync(
    join(home, 'sessions', sessionId, 'events.jsonl'),
    record(0, 'output', { data: 'planted output\r\n' }) +
      record(1, 'marker', {
        label:
          'agent-tty: event log limit reached (250000 events); later events are not recorded',
      }),
  );
}
