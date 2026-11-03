import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendRpc } from '../../src/host/rpcClient.js';
import { probeLibghosttyVt } from '../../src/renderer/readiness.js';
import { sessionDir, socketPath } from '../../src/storage/sessionPaths.js';

import {
  cleanupHome,
  createSession,
  readEvents,
  runCli,
  type SuccessEnvelope,
} from '../helpers.js';

let home = '';
// CI sets AGENT_TTY_REQUIRE_MOUSE_NATIVE=1, so a missing native encoder fails
// these tests there instead of skipping them.
const itWithNativeMouse = it.skipIf(
  (await probeLibghosttyVt()).mouseInputAvailable !== true &&
    process.env.AGENT_TTY_REQUIRE_MOUSE_NATIVE !== '1',
);
afterEach(async () => {
  await cleanupHome(home);
  home = '';
});

describe('mouse command', () => {
  itWithNativeMouse(
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

  itWithNativeMouse(
    'keeps same-cell motion deduplicated after a renderer swap',
    async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-')));
      const session = createSession(home, [
        process.execPath,
        '-e',
        "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?1003h\\x1b[?1006hREADY');",
      ]);
      const env = { AGENT_TTY_HOME: home };
      const ready = runCli(
        ['wait', session, '--text', 'READY', '--timeout', '10000', '--json'],
        env,
      );
      expect(ready.status, ready.stdout + ready.stderr).toBe(0);
      const move = () =>
        runCli(
          [
            '--renderer',
            'libghostty-vt',
            'mouse',
            session,
            'move',
            '--row',
            '2',
            '--col',
            '3',
            '--json',
          ],
          env,
        );

      const first = move();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        result: { reported: true },
      });
      const swap = runCli(
        ['--renderer', 'ghostty-web', 'snapshot', session, '--json'],
        env,
        30_000,
      );
      expect(swap.status, swap.stdout + swap.stderr).toBe(0);
      const second = move();
      expect(second.status, second.stdout + second.stderr).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({
        result: { reported: false, bytesWritten: 0 },
      });
    },
    60_000,
  );

  itWithNativeMouse(
    'keeps same-cell motion deduplicated after the program prints output',
    async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-')));
      // The program prints a line for each input it reads, so the output sits
      // between the two same-cell moves.
      const session = createSession(home, [
        process.execPath,
        '-e',
        "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?1003h\\x1b[?1006hREADY');let n=0;process.stdin.on('data',()=>process.stdout.write('\\r\\nGOT'+(++n)));",
      ]);
      const env = { AGENT_TTY_HOME: home };
      const waitFor = (text: string) =>
        runCli(
          ['wait', session, '--text', text, '--timeout', '10000', '--json'],
          env,
        );
      const move = (col: string) =>
        runCli(
          [
            '--renderer',
            'libghostty-vt',
            'mouse',
            session,
            'move',
            '--row',
            '2',
            '--col',
            col,
            '--json',
          ],
          env,
        );
      const ready = waitFor('READY');
      expect(ready.status, ready.stdout + ready.stderr).toBe(0);

      const first = move('3');
      expect(first.status, first.stdout + first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        result: { reported: true },
      });
      const output = waitFor('GOT1');
      expect(output.status, output.stdout + output.stderr).toBe(0);

      const sameCell = move('3');
      expect(sameCell.status, sameCell.stdout + sameCell.stderr).toBe(0);
      expect(JSON.parse(sameCell.stdout)).toMatchObject({
        result: { reported: false, bytesWritten: 0 },
      });
      const otherCell = move('4');
      expect(otherCell.status, otherCell.stdout + otherCell.stderr).toBe(0);
      expect(JSON.parse(otherCell.stdout)).toMatchObject({
        result: { reported: true },
      });
    },
    60_000,
  );

  itWithNativeMouse(
    'inspect reports the renderer that mouse input booted',
    async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-')));
      const session = createSession(home, ['/bin/sh', '-c', 'exec cat']);
      const env = { AGENT_TTY_HOME: home };
      const moved = runCli(
        [
          '--renderer',
          'libghostty-vt',
          'mouse',
          session,
          'move',
          '--row',
          '0',
          '--col',
          '0',
          '--json',
        ],
        env,
      );
      expect(moved.status, moved.stdout + moved.stderr).toBe(0);

      const inspected = runCli(['inspect', session, '--json'], env);
      expect(inspected.status, inspected.stdout + inspected.stderr).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        result: {
          rendererRuntime: {
            backend: 'libghostty-vt',
            profile: 'reference-dark',
            booted: true,
          },
        },
      });
    },
    30_000,
  );

  itWithNativeMouse(
    'checks cells against the session grid before any output',
    async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-')));
      const session = createSession(home, ['/bin/sh', '-c', 'exec cat'], {
        cols: 100,
      });
      const press = (row: string, col: string) =>
        runCli(
          [
            '--renderer',
            'libghostty-vt',
            'mouse',
            session,
            'press',
            '--button',
            'left',
            '--row',
            row,
            '--col',
            col,
            '--json',
          ],
          { AGENT_TTY_HOME: home },
        );

      const lastCell = press('23', '99');
      expect(lastCell.status, lastCell.stdout + lastCell.stderr).toBe(0);
      const outside = press('999', '0');
      expect(outside.status, outside.stdout + outside.stderr).toBe(2);
      expect(JSON.parse(outside.stdout)).toMatchObject({
        ok: false,
        command: 'mouse',
        error: {
          code: 'INVALID_INPUT',
          message: expect.stringContaining('100x24 terminal grid') as unknown,
        },
      });
      expect(
        (await readEvents(home, session))
          .filter((e) => e.type === 'input_mouse')
          .map((e) => e.payload.col),
      ).toEqual([99]);
    },
    30_000,
  );

  itWithNativeMouse(
    'records whether each batch mouse step reached the child',
    async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-mouse-')));
      const session = createSession(home, [
        process.execPath,
        '-e',
        "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?1000h\\x1b[?1006hREADY');process.stdin.once('data',()=>process.stdout.write('\\x1b[?1000lOFF'));",
      ]);
      const env = { AGENT_TTY_HOME: home, AGENT_TTY_RENDERER: 'libghostty-vt' };
      const press = { action: 'press', button: 'left', row: 2, col: 3 };
      const result = runCli(
        [
          'batch',
          session,
          JSON.stringify([
            { wait: { text: 'READY' } },
            { mouse: press },
            { wait: { text: 'OFF' } },
            { mouse: press },
          ]),
          '--json',
        ],
        env,
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        command: 'batch',
        result: {
          steps: [
            { kind: 'wait' },
            { kind: 'mouse', reported: true, bytesWritten: 9 },
            { kind: 'wait' },
            { kind: 'mouse', reported: false, bytesWritten: 0 },
          ],
        },
      });
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
    for (const option of ['--row', '--col', '--cell-width']) {
      const result = runCli([
        'mouse',
        'missing',
        'press',
        '--button',
        'left',
        '--row',
        '2',
        '--col',
        '1',
        option,
        'abc',
        '--json',
      ]);
      expect(result.status, `${option} abc`).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        command: 'mouse',
        error: { code: 'INVALID_INPUT' },
      });
    }
  }, 30_000);

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
  }, 30_000);

  itWithNativeMouse.each([
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
