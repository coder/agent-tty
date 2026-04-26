import { describe, expect, it } from 'vitest';

import {
  buildRunCompleteSentinel,
  RUN_COMPLETE_SENTINEL_PREFIX,
  RUN_COMPLETE_SENTINEL_SUFFIX,
  RunCompletionSentinelScanner,
} from '../../../src/host/runCompletionSentinel.js';
import type { SentinelPiece } from '../../../src/host/runCompletionSentinel.js';

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

describe('buildRunCompleteSentinel', () => {
  it('returns the expected APC-framed sentinel bytes', () => {
    expect(buildRunCompleteSentinel('__AT_MARKER_123')).toBe(
      '\x1b_agent-tty:run-complete:__AT_MARKER_123\x1b\\',
    );
    expect(RUN_COMPLETE_SENTINEL_PREFIX).toBe('\x1b_agent-tty:run-complete:');
    expect(RUN_COMPLETE_SENTINEL_SUFFIX).toBe('\x1b\\');
  });

  it('rejects empty markers', () => {
    expect(() => buildRunCompleteSentinel('')).toThrow(
      'marker must be a non-empty string',
    );
  });
});

describe('RunCompletionSentinelScanner', () => {
  it('matches a sentinel fully contained in one chunk with output around it', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = '__AT_MARKER_one_chunk';
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
      RUN_COMPLETE_SENTINEL_PREFIX.length + '__AT_MARKER_split'.length - 3,
    ],
    [
      'inside suffix',
      RUN_COMPLETE_SENTINEL_PREFIX.length + '__AT_MARKER_split'.length + 1,
    ],
  ])(
    'matches a sentinel split across two chunks with boundary %s',
    (_, split) => {
      const scanner = new RunCompletionSentinelScanner();
      const marker = '__AT_MARKER_split';
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
    const marker = '__AT_MARKER_bytewise';
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
    const firstMarker = '__AT_MARKER_A';
    const secondMarker = '__AT_MARKER_AB';
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
    const marker = '__AT_MARKER_known';
    const unknownSentinel = buildRunCompleteSentinel('__AT_MARKER_unknown');
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
      buildRunCompleteSentinel('__AT_MARKER_inactive'),
      '\x1b_random',
      'after',
    ].join('');

    expect(scanner.feed(data)).toEqual([{ type: 'output', data }]);
    expect(scanner.flush()).toEqual([]);
  });

  it('does not leak active sentinel bytes into output pieces', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = '__AT_MARKER_secret';
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
    const marker = '__AT_MARKER_flush';
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
    const marker = '__AT_MARKER_once';
    const sentinel = buildRunCompleteSentinel(marker);
    scanner.register(marker);

    expect(scanner.feed(sentinel)).toEqual([{ type: 'run_complete', marker }]);
    expect(scanner.feed(sentinel)).toEqual([
      { type: 'output', data: sentinel },
    ]);
  });

  it('waits for a longer active sentinel when one frame prefixes another', () => {
    const scanner = new RunCompletionSentinelScanner();
    const shortMarker = 'prefix';
    const longMarker = `prefix${RUN_COMPLETE_SENTINEL_SUFFIX}tail`;
    scanner.register(shortMarker);
    scanner.register(longMarker);

    expect(scanner.feed(buildRunCompleteSentinel(shortMarker))).toEqual([]);
    expect(scanner.feed(`tail${RUN_COMPLETE_SENTINEL_SUFFIX}`)).toEqual([
      { type: 'run_complete', marker: longMarker },
    ]);
    expect(scanner.hasActiveMarkers()).toBe(true);
  });

  it('emits a shorter complete sentinel on flush if no longer frame arrives', () => {
    const scanner = new RunCompletionSentinelScanner();
    const shortMarker = 'prefix';
    const longMarker = `prefix${RUN_COMPLETE_SENTINEL_SUFFIX}tail`;
    scanner.register(shortMarker);
    scanner.register(longMarker);

    expect(scanner.feed(buildRunCompleteSentinel(shortMarker))).toEqual([]);
    expect(scanner.flush()).toEqual([
      { type: 'run_complete', marker: shortMarker },
    ]);
    expect(scanner.hasActiveMarkers()).toBe(true);
  });

  it('reports whether active markers remain', () => {
    const scanner = new RunCompletionSentinelScanner();
    const marker = '__AT_MARKER_active';

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
    const marker = '__AT_MARKER_registered';
    const unknownData = `${RUN_COMPLETE_SENTINEL_PREFIX}not-${marker}`;
    scanner.register(marker);

    expect(outputData(scanner.feed(unknownData))).toBe(unknownData);
    expect(scanner.hasActiveMarkers()).toBe(true);
  });
});
