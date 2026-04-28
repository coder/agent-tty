import { describe, expect, it } from 'vitest';

import {
  buildRunCompleteSentinel,
  RUN_COMPLETE_SENTINEL_PREFIX,
  RUN_COMPLETE_SENTINEL_SUFFIX,
  RunCompletionPostambleEchoSanitizer,
  RunCompletionSentinelScanner,
} from '../../../src/host/runCompletionSentinel.js';
import type { SentinelPiece } from '../../../src/host/runCompletionSentinel.js';

function runMarker(value: number): string {
  return `__AT_MARKER_${value.toString(16).padStart(32, '0')}__`;
}

function feedChunks(
  scanner: RunCompletionSentinelScanner,
  chunks: string[],
): SentinelPiece[] {
  return chunks.flatMap((chunk) => scanner.feed(chunk));
}

function outputData(pieces: SentinelPiece[]): string {
  return pieces
    .filter(
      (piece): piece is Extract<SentinelPiece, { type: 'output' }> =>
        piece.type === 'output',
    )
    .map((piece) => piece.data)
    .join('');
}

function oneCodeUnitChunks(data: string): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < data.length; index += 1) {
    chunks.push(data.charAt(index));
  }

  return chunks;
}

function postamble(marker: string): string {
  return `printf '${marker}'\n`;
}

function shellOctalEscapedBytes(value: string): string {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
    .join('');
}

function productionLikePostamble(marker: string): string {
  return `printf '${shellOctalEscapedBytes(buildRunCompleteSentinel(marker))}'\n`;
}

describe('buildRunCompleteSentinel', () => {
  it('returns the expected APC-framed sentinel bytes', () => {
    const marker = runMarker(1);

    expect(buildRunCompleteSentinel(marker)).toBe(
      `\x1b_agent-tty:run-complete:${marker}\x1b\\`,
    );
    expect(RUN_COMPLETE_SENTINEL_PREFIX).toBe('\x1b_agent-tty:run-complete:');
    expect(RUN_COMPLETE_SENTINEL_SUFFIX).toBe('\x1b\\');
  });

  it('rejects non-production marker formats', () => {
    expect(() => buildRunCompleteSentinel('')).toThrow(
      'run marker must match expected format',
    );
    expect(() => buildRunCompleteSentinel('__AT_MARKER_123__')).toThrow(
      'run marker must match expected format',
    );
  });
});

describe('RunCompletionPostambleEchoSanitizer', () => {
  it('removes an exact CRLF postamble echo without suppressing later output', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(10);
    const echo = postamble(marker);
    sanitizer.register(marker, echo);

    expect(
      sanitizer.feed(
        `command echo\r\n${echo.replace(/\n$/u, '\r\n')}user output\n`,
      ),
    ).toBe('command echo\r\nuser output\n');
    expect(sanitizer.feed('more output\n')).toBe('more output\n');
  });

  it('removes an exact LF postamble echo', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(11);
    const echo = postamble(marker);
    sanitizer.register(marker, echo);

    expect(sanitizer.feed(`before${echo}after`)).toBe('beforeafter');
  });

  it('removes postamble echoes split across chunks', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(12);
    const echo = postamble(marker).replace(/\n$/u, '\r\n');
    sanitizer.register(marker, postamble(marker));

    const split = "printf '".length + 8;
    expect(sanitizer.feed(`before${echo.slice(0, split)}`)).toBe('before');
    expect(sanitizer.feed(`${echo.slice(split)}after`)).toBe('after');
  });

  it('preserves interleaved command output while stripping postamble echo bytes', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(120);
    const echo = postamble(marker).replace(/\n$/u, '\r\n');
    sanitizer.register(marker, postamble(marker));

    const split = 24;
    expect(
      sanitizer.feed(
        `${echo.slice(0, split)}visible-output\n${echo.slice(split)}`,
      ),
    ).toBe('visible-output\n');
  });

  it('drops line-editor control sequences interleaved into postamble echo', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(121);
    const echo = postamble(marker).replace(/\n$/u, '\r\n');
    sanitizer.register(marker, postamble(marker));

    const split = 24;
    expect(
      sanitizer.feed(`${echo.slice(0, split)}\x1b[A\x1b[K${echo.slice(split)}`),
    ).toBe('');
  });

  it('drops line-editor control sequences inserted before the old tolerant prefix threshold', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(122);
    const postambleText = productionLikePostamble(marker);
    const echo = postambleText.replace(/\n$/u, '\r\n');
    sanitizer.register(marker, postambleText);

    const split = 'pri'.length;
    expect(
      sanitizer.feed(`${echo.slice(0, split)}\x1b[K${echo.slice(split)}`),
    ).toBe('');
  });

  it('drops line-editor control sequences split across chunks before the tolerant prefix threshold', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(123);
    const postambleText = productionLikePostamble(marker);
    const echo = postambleText.replace(/\n$/u, '\r\n');
    sanitizer.register(marker, postambleText);

    const split = "printf '".length;
    expect(sanitizer.feed(`${echo.slice(0, split)}\x1b[`)).toBe('');
    expect(sanitizer.feed(`K${echo.slice(split)}`)).toBe('');
  });

  it('drops terminal line-wrap carriage returns inserted into the postamble echo', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(125);
    const postambleText = productionLikePostamble(marker);
    const echo = postambleText.replace(/\n$/u, '\r\n');
    sanitizer.register(marker, postambleText);

    const split = String.raw`printf '\03`.length;
    expect(
      sanitizer.feed(`${echo.slice(0, split)}\r${echo.slice(split)}`),
    ).toBe('');
  });

  it('preserves printf-like output with carriage returns that diverges before the tolerant prefix threshold', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(126);
    sanitizer.register(marker, productionLikePostamble(marker));

    const output = "pri\rntf 'hello'\r\n";
    expect(sanitizer.feed(output)).toBe(output);
  });

  it('preserves printf-like output that diverges before the tolerant prefix threshold', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(124);
    sanitizer.register(marker, productionLikePostamble(marker));

    const output = "printf 'hello'\r\n";
    expect(sanitizer.feed(output)).toBe(output);
  });

  it('removes repeated exact postamble text while the marker remains active', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(13);
    const echo = postamble(marker).replace(/\n$/u, '\r\n');
    sanitizer.register(marker, postamble(marker));

    expect(sanitizer.feed(`${echo}visible${echo}`)).toBe('visible');
  });

  it('flushes a pending partial postamble when its marker is deregistered', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const marker = runMarker(14);
    const echo = postamble(marker);
    sanitizer.register(marker, echo);

    expect(sanitizer.feed(`visible${echo.slice(0, 7)}`)).toBe('visible');
    expect(sanitizer.deregister(marker)).toBe(echo.slice(0, 7));
    expect(sanitizer.hasActiveEchoes()).toBe(false);
  });

  it('passes data through unchanged when no postamble echoes are active', () => {
    const sanitizer = new RunCompletionPostambleEchoSanitizer();
    const data = `before${postamble(runMarker(15))}after`;

    expect(sanitizer.feed(data)).toBe(data);
    expect(sanitizer.flush()).toBe('');
  });
});

describe('RunCompletionSentinelScanner', () => {
  it('matches a sentinel fully contained in one chunk with output around it', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(20);
    scanner.register(marker);

    expect(
      scanner.feed(`before${buildRunCompleteSentinel(marker)}after`),
    ).toEqual([
      { type: 'output', data: 'before' },
      { type: 'run_complete', marker },
      { type: 'output', data: 'after' },
    ]);
    expect(scanner.hasActiveMarkers()).toBe(false);
    expect(scanner.flush()).toEqual([]);
  });

  it.each([
    ['inside prefix', 1],
    [
      'inside marker payload',
      RUN_COMPLETE_SENTINEL_PREFIX.length + runMarker(21).length - 3,
    ],
    [
      'inside suffix',
      RUN_COMPLETE_SENTINEL_PREFIX.length + runMarker(21).length + 1,
    ],
  ])(
    'matches a sentinel split across two chunks with boundary %s',
    (_, split) => {
      const scanner = new RunCompletionSentinelScanner();
      const marker = runMarker(21);
      const sentinel = buildRunCompleteSentinel(marker);
      scanner.register(marker);

      expect(scanner.feed(sentinel.slice(0, split))).toEqual([]);
      expect(scanner.feed(sentinel.slice(split))).toEqual([
        { type: 'run_complete', marker },
      ]);
      expect(scanner.hasActiveMarkers()).toBe(false);
    },
  );

  it('matches a sentinel split one byte at a time across the full frame', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(22);
    scanner.register(marker);

    const pieces = [
      ...scanner.feed('before-'),
      ...feedChunks(
        scanner,
        oneCodeUnitChunks(buildRunCompleteSentinel(marker)),
      ),
      ...scanner.feed('-after'),
    ];

    expect(pieces).toEqual([
      { type: 'output', data: 'before-' },
      { type: 'run_complete', marker },
      { type: 'output', data: '-after' },
    ]);
    expect(scanner.hasActiveMarkers()).toBe(false);
  });

  it('completes multiple active markers in input order without cross-matching', () => {
    const scanner = new RunCompletionSentinelScanner();
    const firstMarker = runMarker(23);
    const secondMarker = runMarker(24);
    scanner.register(firstMarker);
    scanner.register(secondMarker);

    expect(
      scanner.feed(
        [
          'start',
          buildRunCompleteSentinel(secondMarker),
          'middle',
          buildRunCompleteSentinel(firstMarker),
          'end',
        ].join(''),
      ),
    ).toEqual([
      { type: 'output', data: 'start' },
      { type: 'run_complete', marker: secondMarker },
      { type: 'output', data: 'middle' },
      { type: 'run_complete', marker: firstMarker },
      { type: 'output', data: 'end' },
    ]);
    expect(scanner.hasActiveMarkers()).toBe(false);
  });

  it('keeps inactive or unknown sentinel-like bytes in output', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(25);
    const unknownSentinel = buildRunCompleteSentinel(runMarker(26));
    const strayApc = '\x1b_random text that is not an active sentinel';
    scanner.register(marker);

    const pieces = scanner.feed(
      `pre${unknownSentinel}mid${strayApc}${buildRunCompleteSentinel(
        marker,
      )}post`,
    );

    expect(pieces).toEqual([
      { type: 'output', data: `pre${unknownSentinel}mid${strayApc}` },
      { type: 'run_complete', marker },
      { type: 'output', data: 'post' },
    ]);
  });

  it('passes all data through unchanged when no markers are active', () => {
    const scanner = new RunCompletionSentinelScanner();
    const data = [
      'before',
      buildRunCompleteSentinel(runMarker(27)),
      '\x1b_random',
      'after',
    ].join('');

    expect(scanner.feed(data)).toEqual([{ type: 'output', data }]);
    expect(scanner.flush()).toEqual([]);
  });

  it('does not leak active sentinel bytes into output pieces', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(28);
    const sentinel = buildRunCompleteSentinel(marker);
    scanner.register(marker);

    const pieces = feedChunks(scanner, [
      'visible-before',
      sentinel.slice(0, RUN_COMPLETE_SENTINEL_PREFIX.length + 4),
      sentinel.slice(RUN_COMPLETE_SENTINEL_PREFIX.length + 4),
      'visible-after',
    ]);

    expect(pieces).toEqual([
      { type: 'output', data: 'visible-before' },
      { type: 'run_complete', marker },
      { type: 'output', data: 'visible-after' },
    ]);

    for (const piece of pieces) {
      if (piece.type !== 'output') {
        continue;
      }
      expect(piece.data).not.toContain(RUN_COMPLETE_SENTINEL_PREFIX);
      expect(piece.data).not.toContain('agent-tty:run-complete:');
      expect(piece.data).not.toContain('__AT_MARKER_');
      expect(piece.data).not.toContain(marker);
    }
  });

  it('flushes a pending non-sentinel tail once', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(29);
    scanner.register(marker);

    expect(
      scanner.feed(`visible${RUN_COMPLETE_SENTINEL_PREFIX.slice(0, 4)}`),
    ).toEqual([{ type: 'output', data: 'visible' }]);
    expect(scanner.flush()).toEqual([
      { type: 'output', data: RUN_COMPLETE_SENTINEL_PREFIX.slice(0, 4) },
    ]);
    expect(scanner.flush()).toEqual([]);
  });

  it('passes the same sentinel through as output after deactivation', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(30);
    const sentinel = buildRunCompleteSentinel(marker);
    scanner.register(marker);

    expect(scanner.feed(sentinel)).toEqual([{ type: 'run_complete', marker }]);
    expect(scanner.feed(sentinel)).toEqual([
      { type: 'output', data: sentinel },
    ]);
  });

  it('rejects non-production markers so prefix-overlap cases are impossible', () => {
    const scanner = new RunCompletionSentinelScanner();

    expect(() => scanner.register('prefix')).toThrow(
      'run marker must match expected format',
    );
  });

  it('reports whether active markers remain', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(31);

    expect(scanner.hasActiveMarkers()).toBe(false);
    scanner.register(marker);
    scanner.register(marker);
    expect(scanner.hasActiveMarkers()).toBe(true);
    expect(scanner.feed(buildRunCompleteSentinel(marker))).toEqual([
      { type: 'run_complete', marker },
    ]);
    expect(scanner.hasActiveMarkers()).toBe(false);
  });

  it('preserves unknown output data when an active marker remains registered', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = runMarker(32);
    const unknownData = `${RUN_COMPLETE_SENTINEL_PREFIX}not-${marker}`;
    scanner.register(marker);

    expect(outputData(scanner.feed(unknownData))).toBe(unknownData);
    expect(scanner.hasActiveMarkers()).toBe(true);
  });
});
