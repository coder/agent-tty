import { afterEach, describe, expect, it } from 'vitest';

import { computeScreenHash } from '../../src/renderer/canonicalScreen.js';
import { resolveProfile } from '../../src/renderer/profiles.js';
import type { RendererBackend } from '../../src/renderer/backend.js';
import type { ReplayInput } from '../../src/renderer/types.js';
import { GhosttyWebBackend } from '../../src/renderer/ghosttyWeb/index.js';
import { LibghosttyVtBackend } from '../../src/renderer/libghosttyVt/index.js';

// Gate the whole suite on the optional native engine: when
// @coder/libghostty-vt-node is unavailable there is no second renderer to
// compare against, so every case skips cleanly (mirrors the nativeAvailable
// pattern in test/e2e/libghostty-vt-renderer.test.ts). Do NOT fall back to a
// length>0 guard — a converged blank/short screen is a valid case here.
let nativeAvailable = false;
let nativeSkipReason = '';
try {
  await import('@coder/libghostty-vt-node');
  nativeAvailable = true;
} catch (error) {
  nativeSkipReason = error instanceof Error ? error.message : String(error);
}
const maybeIt = nativeAvailable ? it : it.skip;

const PROFILE = resolveProfile('reference-dark');
const SESSION_ID = 'cross-backend-screen-hash';
const SHA_256_HEX = /^[a-f0-9]{64}$/u;

function timestampFor(seq: number): string {
  return new Date(Date.UTC(2026, 5, 5, 12, 0, seq)).toISOString();
}

function singleOutputReplayInput(
  data: string,
  options: { cols?: number; rows?: number } = {},
): ReplayInput {
  return {
    sessionId: SESSION_ID,
    initialCols: options.cols ?? 80,
    initialRows: options.rows ?? 24,
    targetSeq: 0,
    events: [
      {
        seq: 0,
        ts: timestampFor(0),
        type: 'output',
        payload: { data },
      },
    ],
  };
}

interface CrossBackendResult {
  webHash: string;
  nativeHash: string;
  webLines: string[];
  nativeLines: string[];
}

describe('cross-backend screen hash', { timeout: 120_000 }, () => {
  const backends: RendererBackend[] = [];

  afterEach(async () => {
    while (backends.length > 0) {
      const backend = backends.pop();
      if (backend !== undefined) {
        await backend.dispose();
      }
    }
  });

  // Boot BOTH renderer backends over the SAME ReplayInput, then route each
  // snapshot's visibleLines through computeScreenHash. Returning the raw lines
  // too makes any divergence legible in the assertion diff.
  async function hashBothBackends(
    input: ReplayInput,
  ): Promise<CrossBackendResult> {
    const webBackend = new GhosttyWebBackend(SESSION_ID, PROFILE);
    backends.push(webBackend);
    const nativeBackend = new LibghosttyVtBackend(SESSION_ID, PROFILE);
    backends.push(nativeBackend);

    await webBackend.boot();
    await nativeBackend.boot();

    await webBackend.replayTo(input);
    await nativeBackend.replayTo(input);

    const webSnapshot = await webBackend.snapshot();
    const nativeSnapshot = await nativeBackend.snapshot();

    return {
      webHash: computeScreenHash(webSnapshot),
      nativeHash: computeScreenHash(nativeSnapshot),
      webLines: webSnapshot.visibleLines.map((line) => line.text),
      nativeLines: nativeSnapshot.visibleLines.map((line) => line.text),
    };
  }

  async function expectAgreement(input: ReplayInput): Promise<void> {
    const result = await hashBothBackends(input);
    // Compare the decoded lines first so a mismatch surfaces the offending
    // text, then assert the hashes themselves agree.
    expect(result.nativeLines).toEqual(result.webLines);
    expect(result.webHash).toMatch(SHA_256_HEX);
    expect(result.nativeHash).toBe(result.webHash);
  }

  maybeIt(
    nativeAvailable
      ? 'agrees on an ASCII full screen'
      : `skips because @coder/libghostty-vt-node is unavailable: ${nativeSkipReason}`,
    async () => {
      const rows = Array.from(
        { length: 12 },
        (_, index) => `row ${String(index)} of ascii content`,
      ).join('\r\n');
      await expectAgreement(singleOutputReplayInput(rows));
    },
  );

  maybeIt(
    nativeAvailable
      ? 'agrees on an interior cursor-positioned gap'
      : `skips because @coder/libghostty-vt-node is unavailable: ${nativeSkipReason}`,
    async () => {
      // Write 'a' at the home position, jump to row 1 col 6 (CSI 1;6H is
      // 1-based), then write 'b'. The interior cols between them are genuine
      // blank cells that both backends must render as spaces, yielding
      // 'a    b' on row 0 after trailing-space trimming.
      await expectAgreement(singleOutputReplayInput('a\x1b[1;6Hb'));
    },
  );

  maybeIt(
    nativeAvailable
      ? 'agrees on CJK wide glyphs'
      : `skips because @coder/libghostty-vt-node is unavailable: ${nativeSkipReason}`,
    async () => {
      // 'kanji-kanji-te-su-to' in CJK: each glyph occupies two columns.
      await expectAgreement(singleOutputReplayInput('漢字テスト'));
    },
  );

  maybeIt(
    nativeAvailable
      ? 'agrees on grapheme clusters (NFD combining mark and a ZWJ family emoji)'
      : `skips because @coder/libghostty-vt-node is unavailable: ${nativeSkipReason}`,
    async () => {
      // 'e' + combining acute accent (NFD) on row 0, then a ZWJ family emoji
      // (man + ZWJ + woman + ZWJ + girl + ZWJ + boy) on row 1. Both backends
      // must keep the FULL grapheme cluster rather than dropping continuation
      // codepoints.
      const combiningE = 'e\u0301';
      const zwjFamily =
        '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}';
      await expectAgreement(
        singleOutputReplayInput(`${combiningE}\r\n${zwjFamily}`),
      );
    },
  );

  maybeIt(
    nativeAvailable
      ? 'agrees on a line with a trailing non-breaking space'
      : `skips because @coder/libghostty-vt-node is unavailable: ${nativeSkipReason}`,
    async () => {
      // NBSP (U+00A0) is not ASCII 0x20, so neither backend trims it; the
      // trailing NBSP must survive identically in the canonical text.
      await expectAgreement(singleOutputReplayInput('value\u00a0'));
    },
  );

  maybeIt(
    nativeAvailable
      ? 'agrees on a short, mostly-blank screen'
      : `skips because @coder/libghostty-vt-node is unavailable: ${nativeSkipReason}`,
    async () => {
      // A single short line leaves the rest of the viewport blank, exercising
      // the libghostty pad-to-rows alignment against ghostty-web's full grid.
      await expectAgreement(singleOutputReplayInput('hi'));
    },
  );
});
