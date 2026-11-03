import { describe, expect, it } from 'vitest';

import { TerminalQueryResponder } from '../../../src/pty/terminalQueryResponder.js';

const BACKGROUND = '#1e1e2e';
const FOREGROUND = '#cdd6f4';
// `#1e1e2e` / `#cdd6f4` expanded to xterm 16-bit-per-channel form.
const BACKGROUND_REPLY_BODY = 'rgb:1e1e/1e1e/2e2e';
const FOREGROUND_REPLY_BODY = 'rgb:cdcd/d6d6/f4f4';

function makeResponder(): TerminalQueryResponder {
  return new TerminalQueryResponder({
    backgroundColor: BACKGROUND,
    foregroundColor: FOREGROUND,
  });
}

describe('TerminalQueryResponder', () => {
  it('answers an OSC 11 background query terminated by BEL', () => {
    const responder = makeResponder();
    expect(responder.consume('\x1b]11;?\x07')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x07`,
    );
  });

  it('answers an OSC 11 background query terminated by ST and replies with ST', () => {
    const responder = makeResponder();
    expect(responder.consume('\x1b]11;?\x1b\\')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x1b\\`,
    );
  });

  it('answers an OSC 10 foreground query', () => {
    const responder = makeResponder();
    expect(responder.consume('\x1b]10;?\x07')).toBe(
      `\x1b]10;${FOREGROUND_REPLY_BODY}\x07`,
    );
  });

  it('answers a DSR status query with "terminal OK"', () => {
    const responder = makeResponder();
    expect(responder.consume('\x1b[5n')).toBe('\x1b[0n');
  });

  it('answers the OSC 11 + DSR handshake Neovim emits at startup', () => {
    const responder = makeResponder();
    // Neovim writes the OSC 11 query immediately followed by the DSR sentinel.
    expect(responder.consume('\x1b]11;?\x07\x1b[5n')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x07\x1b[0n`,
    );
  });

  it('answers a query split across consecutive chunks (OSC)', () => {
    const responder = makeResponder();
    expect(responder.consume('\x1b]1')).toBe('');
    expect(responder.consume('1;')).toBe('');
    expect(responder.consume('?\x07')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x07`,
    );
  });

  it('answers a query split across consecutive chunks (CSI)', () => {
    const responder = makeResponder();
    expect(responder.consume('\x1b[')).toBe('');
    expect(responder.consume('5')).toBe('');
    expect(responder.consume('n')).toBe('\x1b[0n');
  });

  it('answers a query embedded between surrounding output', () => {
    const responder = makeResponder();
    expect(responder.consume('before\x1b]11;?\x07after')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x07`,
    );
  });

  it('answers multiple queries in one chunk, in order', () => {
    const responder = makeResponder();
    expect(responder.consume('\x1b]10;?\x07text\x1b]11;?\x07\x1b[5n')).toBe(
      `\x1b]10;${FOREGROUND_REPLY_BODY}\x07\x1b]11;${BACKGROUND_REPLY_BODY}\x07\x1b[0n`,
    );
  });

  describe('does not respond to non-queries', () => {
    it('plain text', () => {
      expect(makeResponder().consume('hello world\n')).toBe('');
    });

    it('an SGR color sequence', () => {
      expect(makeResponder().consume('\x1b[31mred\x1b[0m')).toBe('');
    });

    it('an OSC window-title set', () => {
      expect(makeResponder().consume('\x1b]0;my title\x07')).toBe('');
    });

    it('an OSC 11 set request (color value, not a "?" query)', () => {
      expect(makeResponder().consume('\x1b]11;rgb:0000/0000/0000\x07')).toBe(
        '',
      );
    });

    it('a Primary Device Attributes query (final byte "c")', () => {
      expect(makeResponder().consume('\x1b[c')).toBe('');
    });

    it('a cursor-position report query (DSR 6n)', () => {
      expect(makeResponder().consume('\x1b[6n')).toBe('');
    });
  });

  it('recovers after an aborted escape sequence', () => {
    const responder = makeResponder();
    // An incomplete CSI is cut off by a fresh, complete OSC query.
    expect(responder.consume('\x1b[12')).toBe('');
    expect(responder.consume('\x1b]11;?\x07')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x07`,
    );
  });

  it('stays usable across many sequential queries', () => {
    const responder = makeResponder();
    for (let iteration = 0; iteration < 5; iteration += 1) {
      expect(responder.consume('\x1b[5n')).toBe('\x1b[0n');
    }
  });

  it('does not answer an OSC that starts exactly like a query but carries extra data, then resyncs', () => {
    const responder = makeResponder();
    // Payload begins with the exact background-query bytes `11;?` and then keeps
    // going, well past MAX_OSC_PAYLOAD_LENGTH (which only bounds memory). It must
    // not be mistaken for the `11;?` query, and the scanner must return to ground
    // so the next genuine query is still answered.
    const overLongPayload = `\x1b]11;?${'x'.repeat(200)}\x07`;
    expect(responder.consume(overLongPayload)).toBe('');
    expect(responder.consume('\x1b]11;?\x07')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x07`,
    );
  });

  it('recovers from an OSC terminated by the 8-bit C1 ST (0x9c) and answers the next query', () => {
    const responder = makeResponder();
    // An OSC title-set terminated by the 8-bit String Terminator (0x9c) must
    // close so the following background query is not swallowed.
    expect(responder.consume('\x1b]0;title\x9c')).toBe('');
    expect(responder.consume('\x1b]11;?\x07')).toBe(
      `\x1b]11;${BACKGROUND_REPLY_BODY}\x07`,
    );
  });

  describe('XTGETTCAP and DECRQSS', () => {
    const ESC = '\x1b';
    const ST = `${ESC}\\`;
    // Hex of the terminfo source strings `\E[38;2;%p1%d;%p2%d;%p3%dm` and `\E[48;...`.
    const SETRGBF_VALUE =
      '5C455B33383B323B25703125643B25703225643B25703325646D';
    const SETRGBB_VALUE =
      '5C455B34383B323B25703125643B25703225643B25703325646D';
    const TC = '5463';
    const RGB = '524742';
    const SETRGBF = '73657472676266';
    const SETRGBB = '73657472676262';
    const xtgettcap = (list: string): string => `${ESC}P+q${list}${ST}`;
    const DECRQSS_DECLINE = `${ESC}P0$r${ST}`;

    it('answers a Tc query with a valueless positive reply', () => {
      expect(makeResponder().consume(xtgettcap(TC))).toBe(
        `${ESC}P1+r${TC}${ST}`,
      );
    });

    it("answers Neovim's four-name query with four replies in request order", () => {
      expect(
        makeResponder().consume(
          xtgettcap([TC, RGB, SETRGBF, SETRGBB].join(';')),
        ),
      ).toBe(
        [
          `${ESC}P1+r${TC}${ST}`,
          `${ESC}P1+r${RGB}${ST}`,
          `${ESC}P1+r${SETRGBF}=${SETRGBF_VALUE}${ST}`,
          `${ESC}P1+r${SETRGBB}=${SETRGBB_VALUE}${ST}`,
        ].join(''),
      );
    });

    it('stays silent for an unknown capability name', () => {
      expect(makeResponder().consume(xtgettcap('436F'))).toBe('');
    });

    it('answers only the known names of a mixed query', () => {
      expect(
        makeResponder().consume(xtgettcap([TC, '436F', RGB].join(';'))),
      ).toBe(`${ESC}P1+r${TC}${ST}${ESC}P1+r${RGB}${ST}`);
    });

    it('stays silent for odd-length and non-hex tokens', () => {
      expect(makeResponder().consume(xtgettcap('546'))).toBe('');
      expect(makeResponder().consume(xtgettcap('ZZ'))).toBe('');
      expect(makeResponder().consume(xtgettcap(`;${TC.slice(0, 3)};`))).toBe(
        '',
      );
    });

    it('declines a DECRQSS SGR query', () => {
      expect(makeResponder().consume(`${ESC}P$qm${ST}`)).toBe(DECRQSS_DECLINE);
    });

    it("declines Neovim's combined SGR set plus DECRQSS write exactly once", () => {
      expect(
        makeResponder().consume(`${ESC}[0m${ESC}[48;2;1;2;3m${ESC}P$qm${ST}`),
      ).toBe(DECRQSS_DECLINE);
    });

    it('answers a DCS terminated by the 8-bit C1 ST, replying with the 7-bit ST', () => {
      expect(makeResponder().consume(`${ESC}P+q${TC}\x9c`)).toBe(
        `${ESC}P1+r${TC}${ST}`,
      );
    });

    it('answers a DCS split across chunks on its final byte', () => {
      const responder = makeResponder();
      expect(responder.consume(`${ESC}P+q54`)).toBe('');
      expect(responder.consume('63')).toBe('');
      expect(responder.consume(ESC)).toBe('');
      expect(responder.consume('\\')).toBe(`${ESC}P1+r${TC}${ST}`);
    });

    it('stays silent for another DECRQSS request', () => {
      expect(makeResponder().consume(`${ESC}P$qr${ST}`)).toBe('');
    });

    it('stays silent for an overlong DCS and still answers the next query', () => {
      const responder = makeResponder();
      expect(responder.consume(`${ESC}P+q${TC}${'x'.repeat(400)}${ST}`)).toBe(
        '',
      );
      expect(responder.consume(xtgettcap(TC))).toBe(`${ESC}P1+r${TC}${ST}`);
    });

    it('aborts a DCS on an ESC that is not ST and answers the next query', () => {
      const responder = makeResponder();
      expect(responder.consume(`${ESC}P+q${TC}${ESC}${xtgettcap(RGB)}`)).toBe(
        `${ESC}P1+r${RGB}${ST}`,
      );
      expect(responder.consume(`${ESC}P+q${TC}${ESC}Zhello`)).toBe('');
      expect(responder.consume(xtgettcap(TC))).toBe(`${ESC}P1+r${TC}${ST}`);
    });
  });

  it('rejects a malformed background color at construction', () => {
    expect(
      () =>
        new TerminalQueryResponder({
          backgroundColor: 'not-a-color',
          foregroundColor: FOREGROUND,
        }),
    ).toThrow();
  });
});
