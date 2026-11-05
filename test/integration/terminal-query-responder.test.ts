import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupHome,
  createSession,
  destroySession,
  readEvents,
  sleep,
} from '../helpers.js';

// A child program that exercises the host's terminal-query responder end to end:
// it puts its PTY into raw mode (so the host's reply is delivered byte-for-byte
// and never echoed), emits an OSC 11 background-color query, then writes back
// everything it received on stdin so the test can assert the reply arrived. The
// `\\x1b` / `\\x07` escapes are emitted as literal backslash sequences here so
// that the spawned `node -e` evaluates them into the ESC / BEL control bytes.
const PROBE_CHILD_SCRIPT = [
  'const stdin = process.stdin;',
  "if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);",
  "let received = '';",
  "stdin.on('data', (chunk) => { received += chunk.toString('utf8'); });",
  "setTimeout(() => { process.stdout.write('\\x1b]11;?\\x07'); }, 400);",
  'setTimeout(() => {',
  "  process.stdout.write('\\nREPLY=' + JSON.stringify(received) + '\\n');",
  '  process.exit(0);',
  '}, 1800);',
].join('\n');

// Neovim's startup probes when COLORTERM is unset or empty: an XTGETTCAP query
// for Tc/RGB/setrgbf/setrgbb, then an SGR set followed by a DECRQSS SGR query.
// The reply is printed as JSON so the test can compare it as an exact string
// (ESC is not printable, so a regex over the raw output would be fragile).
const NVIM_PROBE_CHILD_SCRIPT = [
  'const stdin = process.stdin;',
  "if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);",
  "let received = '';",
  "stdin.on('data', (chunk) => { received += chunk.toString('utf8'); });",
  'setTimeout(() => {',
  "  process.stdout.write('\\x1bP+q5463;524742;73657472676266;73657472676262\\x1b\\\\');",
  "  process.stdout.write('\\x1b[0m\\x1b[48;2;1;2;3m\\x1bP$qm\\x1b\\\\');",
  '}, 400);',
  'setTimeout(() => {',
  "  process.stdout.write('\\nREPLY=' + JSON.stringify(received) + '\\n');",
  '  process.exit(0);',
  '}, 1800);',
].join('\n');

// Poll the on-disk event log instead of sleeping a fixed duration: return as
// soon as the pattern lands, capped at the deadline so a real failure still
// surfaces (instead of paying the full wait on every green run).
async function readOutputUntil(
  home: string,
  sessionId: string,
  pattern: RegExp,
  deadlineMs: number,
): Promise<string> {
  const pollMs = 100;
  for (let waited = 0; ; waited += pollMs) {
    const events = await readEvents(home, sessionId);
    const output = events
      .filter((event) => event.type === 'output')
      .map((event) =>
        typeof event.payload.data === 'string' ? event.payload.data : '',
      )
      .join('');
    if (pattern.test(output) || waited >= deadlineMs) {
      return output;
    }
    await sleep(pollMs);
  }
}

// `#1e1e2e` (the default `reference-dark` background) in xterm OSC reply form.
const EXPECTED_BACKGROUND_REPLY = ']11;rgb:1e1e/1e1e/2e2e';

let testHome = '';

describe('terminal-query-responder integration', { timeout: 30000 }, () => {
  beforeEach(async () => {
    testHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-home-')));
  });

  afterEach(async () => {
    await cleanupHome(testHome);
  });

  it('replies to an OSC 11 background query and the child receives it on stdin', async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome, [execPath, '-e', PROBE_CHILD_SCRIPT]);

      // The child probes at +400ms and reports what it received at +1800ms.
      // Require the reply body to sit INSIDE the child's `REPLY="..."` JSON, so
      // the assertion proves a genuine round-trip through the child's stdin —
      // not merely that the bytes appear somewhere in the output (e.g. a kernel
      // echo, which would land outside the quotes).
      const replyRoundTrip = new RegExp(
        `REPLY="[^"]*${EXPECTED_BACKGROUND_REPLY}`,
      );

      const output = await readOutputUntil(
        testHome,
        sessionId,
        replyRoundTrip,
        4000,
      );

      expect(output).toMatch(replyRoundTrip);
    } finally {
      destroySession(testHome, sessionId);
    }
  });

  it("answers Neovim's XTGETTCAP query and declines its DECRQSS query", async () => {
    let sessionId = '';

    try {
      sessionId = createSession(testHome, [
        execPath,
        '-e',
        NVIM_PROBE_CHILD_SCRIPT,
      ]);

      const replyLine = /REPLY=("(?:[^"\\]|\\.)*")/u;
      const output = await readOutputUntil(
        testHome,
        sessionId,
        replyLine,
        5000,
      );

      const reply = JSON.parse(replyLine.exec(output)?.[1] ?? '""') as string;
      expect(reply).toBe(
        [
          '\x1bP1+r5463\x1b\\',
          '\x1bP1+r524742\x1b\\',
          // Hex of `\E[38;2;%p1%d;%p2%d;%p3%dm` and `\E[48;2;%p1%d;%p2%d;%p3%dm`.
          '\x1bP1+r73657472676266=5C455B33383B323B25703125643B25703225643B25703325646D\x1b\\',
          '\x1bP1+r73657472676262=5C455B34383B323B25703125643B25703225643B25703325646D\x1b\\',
          '\x1bP0$r\x1b\\',
        ].join(''),
      );
    } finally {
      destroySession(testHome, sessionId);
    }
  });
});
