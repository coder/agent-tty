import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendRpc } from '../../src/host/rpcClient.js';
import { sessionDir, socketPath } from '../../src/storage/sessionPaths.js';

import {
  cleanupHome,
  createSession,
  readEvents,
  runCli,
  type SuccessEnvelope,
} from '../helpers.js';

let home = '';
const hasNativeMouse = await import('@coder/libghostty-vt-node')
  .then((native) => {
    const terminal = native.createTerminal({ cols: 1, rows: 1 });
    try {
      return 'encodeMouse' in terminal;
    } finally {
      terminal.dispose();
    }
  })
  .catch(() => false);
afterEach(async () => {
  await cleanupHome(home);
  home = '';
});

describe('mouse command', () => {
  it.skipIf(
    !hasNativeMouse && process.env.AGENT_TTY_REQUIRE_MOUSE_NATIVE !== '1',
  )(
    'retains held buttons across concurrent requests while the native backend boots',
    async () => {
      home = await realpath(
        await mkdtemp(join(tmpdir(), 'agent-tty-mouse-race-')),
      );
      const session = createSession(home, [
        process.execPath,
        '-e',
        "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?1003h\\x1b[?1006hREADY');",
      ]);
      const ready = runCli(
        [
          '--renderer',
          'ghostty-web',
          'wait',
          session,
          '--text',
          'READY',
          '--timeout',
          '10000',
          '--json',
        ],
        { AGENT_TTY_HOME: home },
      );
      expect(ready.status, ready.stdout + ready.stderr).toBe(0);
      const socket = socketPath(sessionDir(home, session));
      const common = { row: 2, col: 3, rendererName: 'libghostty-vt' };
      await Promise.all([
        sendRpc(socket, 'mouse', {
          ...common,
          action: 'press',
          button: 'left',
        }),
        sendRpc(socket, 'mouse', {
          ...common,
          action: 'press',
          button: 'right',
        }),
      ]);
      await sendRpc(socket, 'mouse', {
        ...common,
        action: 'release',
        button: 'right',
      });
      await sendRpc(socket, 'mouse', { ...common, action: 'move', col: 4 });
      const events = (await readEvents(home, session)).filter(
        (event) => event.type === 'input_mouse',
      );
      expect(events.at(-1)?.payload.dataBase64).toBe(
        Buffer.from('\x1b[<32;5;3M').toString('base64'),
      );
    },
    30_000,
  );

  it('documents pixel geometry and reports invalid input before resolving a session', () => {
    const help = runCli(['mouse', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--cell-width');
    const invalid = runCli([
      'mouse',
      'missing',
      'click',
      '--col',
      '1',
      '--row',
      '2',
      '--cell-width',
      '10',
      '--cell-height',
      '20',
      '--json',
    ]);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('rejects an unsupported renderer without booting a browser or writing input', async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-')));
    const session = createSession(home, ['/bin/sh', '-c', 'exec cat']);
    const result = runCli(
      [
        '--renderer',
        'ghostty-web',
        'mouse',
        session,
        'press',
        '--button',
        'left',
        '--col',
        '1',
        '--row',
        '2',
        '--cell-width',
        '10',
        '--cell-height',
        '20',
        '--json',
      ],
      { AGENT_TTY_HOME: home },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE' },
    });
    expect(
      (await readEvents(home, session)).filter((e) => e.type === 'input_mouse'),
    ).toEqual([]);
  });

  // CI with the released optional package still tests the capability error.
  // Set this flag when consuming the mouse-encoder branch; missing native support must fail.
  it
    .skipIf(
      !hasNativeMouse && process.env.AGENT_TTY_REQUIRE_MOUSE_NATIVE !== '1',
    )
    .each([
      ['SGR', '\x1b[?1000h\x1b[?1006h', Buffer.from('\x1b[<0;223;3M')],
      ['SGR-pixels', '\x1b[?1000h\x1b[?1016h', Buffer.from('\x1b[<0;2220;40M')],
      ['X10', '\x1b[?1000h', Buffer.from([27, 91, 77, 32, 255, 35])],
      [
        'UTF-8',
        '\x1b[?1000h\x1b[?1005h',
        Buffer.from([27, 91, 77, 32, 0xc3, 0xbf, 35]),
      ],
      ['URXVT', '\x1b[?1000h\x1b[?1015h', Buffer.from('\x1b[32;223;3M')],
      ['disabled', '', Buffer.alloc(0)],
    ] as const)(
    'delivers %s bytes to a PTY and retains them for replay',
    async (_name, mode, expected) => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-')));
      const fixture = `process.stdin.setRawMode(true); process.stdout.write(${JSON.stringify(mode + 'READY')}); process.stdin.on('data', b => { process.stdout.write('BYTES:' + b.toString('hex') + '\\n'); });`;
      const session = createSession(home, [process.execPath, '-e', fixture], {
        cols: 300,
      });
      const env = { AGENT_TTY_HOME: home };
      const ready = runCli(
        [
          '--renderer',
          'libghostty-vt',
          'wait',
          session,
          '--text',
          'READY',
          '--timeout',
          '10000',
          '--json',
        ],
        env,
      );
      expect(ready.status, ready.stdout + ready.stderr).toBe(0);
      const result = runCli(
        [
          '--renderer',
          'libghostty-vt',
          'mouse',
          session,

          'press',
          '--button',
          'left',
          '--col',
          '222',
          '--row',
          '2',
          ...(_name === 'SGR-pixels'
            ? ['--cell-width', '10', '--cell-height', '20']
            : []),
          '--json',
        ],
        env,
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const envelope = JSON.parse(result.stdout) as SuccessEnvelope<{
        seq: number;
        bytesWritten: number;
      }>;
      expect(envelope.result.bytesWritten).toBe(expected.length);
      if (expected.length > 0) {
        const received = runCli(
          [
            '--renderer',
            'libghostty-vt',
            'wait',
            session,
            '--text',
            `BYTES:${expected.toString('hex')}`,
            '--timeout',
            '10000',
            '--json',
          ],
          env,
        );
        expect(received.status, received.stdout + received.stderr).toBe(0);
      }
      const event = (await readEvents(home, session)).find(
        (e) => e.seq === envelope.result.seq,
      );
      expect(event).toMatchObject({
        type: 'input_mouse',
        payload: { dataBase64: expected.toString('base64') },
      });
      const snapshot = runCli(
        ['--renderer', 'libghostty-vt', 'snapshot', session, '--json'],
        env,
      );
      expect(snapshot.status, snapshot.stdout + snapshot.stderr).toBe(0);
    },
    30_000,
  );
});
