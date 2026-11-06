import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDefaultPlaywrightBrowsersPath } from '../../src/renderer/browserPath.js';
import { resolveProfile } from '../../src/renderer/profiles.js';
import type {
  RenderProfileConfig,
  ReplayInput,
} from '../../src/renderer/types.js';
import { GhosttyWebBackend } from '../../src/renderer/ghosttyWeb/index.js';
import { probeUsedFonts } from '../../src/renderer/ghosttyWeb/missingGlyphs.js';

const PROFILE = resolveProfile('reference-dark');
const SESSION_ID = 'renderer-backend-integration';

function timestampFor(seq: number): string {
  return new Date(Date.UTC(2026, 2, 20, 12, 0, seq)).toISOString();
}

function createReplayInput(
  events: ReplayInput['events'],
  options: {
    initialCols?: number;
    initialRows?: number;
    sessionId?: string;
    targetSeq?: number;
  } = {},
): ReplayInput {
  const targetSeq = options.targetSeq ?? events.at(-1)?.seq ?? -1;

  return {
    sessionId: options.sessionId ?? SESSION_ID,
    initialCols: options.initialCols ?? 80,
    initialRows: options.initialRows ?? 24,
    events,
    targetSeq,
  };
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function visibleTextFromSnapshot(
  snapshot: Awaited<ReturnType<GhosttyWebBackend['snapshot']>>,
): string {
  const visibleText = snapshot.visibleLines.map((line) => line.text).join('\n');
  if (visibleText.length === 0) {
    throw new Error('snapshot visible text must be non-empty');
  }

  return visibleText;
}

async function readValidPngFile(
  outputPath: string,
  label: string,
): Promise<Buffer> {
  const pngBuffer = await readFile(outputPath);
  if (pngBuffer.length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length) {
    throw new Error(`${label} must include the PNG signature bytes`);
  }
  if (!pngBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} must start with the PNG signature`);
  }

  return pngBuffer;
}

async function listedGlyphs(
  profile: RenderProfileConfig,
  text: string,
): Promise<string[]> {
  const renderer = new GhosttyWebBackend(SESSION_ID, profile);
  // oxfmt-ignore
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-faces-')));
  try {
    await renderer.boot();
    await renderer.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: `${text}\r\n` },
        },
      ]),
    );
    const shot = await renderer.screenshot(join(outputDir, 'faces.png'));
    if (shot.missingGlyphs === undefined) {
      throw new Error('the screenshot must run the glyph check');
    }
    return shot.missingGlyphs.map((glyph) => glyph.codePoint);
  } finally {
    await renderer.dispose();
    await rm(outputDir, { recursive: true, force: true });
  }
}

describe('GhosttyWebBackend integration', { timeout: 120_000 }, () => {
  let backend: GhosttyWebBackend;

  beforeEach(() => {
    backend = new GhosttyWebBackend(SESSION_ID, PROFILE);
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it('boots and disposes cleanly', async () => {
    expect(backend.isBooted).toBe(false);

    await backend.boot();

    expect(backend.isBooted).toBe(true);

    await backend.dispose();

    expect(backend.isBooted).toBe(false);
  });

  it('boots custom profiles without a bundled font identity', async () => {
    const customBackend = new GhosttyWebBackend(`${SESSION_ID}-custom`, {
      name: 'custom-no-font-identity',
      theme: 'dark',
      fontFamily: 'monospace',
      fontSize: 14,
      cursorStyle: 'block',
      backgroundColor: '#000000',
      foregroundColor: '#ffffff',
    });

    try {
      await customBackend.boot();
      expect(customBackend.isBooted).toBe(true);
    } finally {
      await customBackend.dispose();
    }
  });

  it('resolves the browser cache from the original HOME when HOME is isolated before boot', async () => {
    // oxfmt-ignore
    const isolatedHome = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-home-')));
    const previousHome = process.env.HOME;
    const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (previousHome === undefined) {
      throw new Error(
        'expected HOME to be defined before isolating renderer boot',
      );
    }

    try {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.HOME = isolatedHome;

      await backend.boot();

      const expectedBrowserCachePath = resolveDefaultPlaywrightBrowsersPath(
        previousHome,
        process.platform,
      );
      if (expectedBrowserCachePath === null) {
        throw new Error(
          `expected a default Playwright browser cache path for ${process.platform}`,
        );
      }

      expect(backend.isBooted).toBe(true);
      expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
        expectedBrowserCachePath,
      );
    } finally {
      if (previousBrowsersPath === undefined) {
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      } else {
        process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
      }
      process.env.HOME = previousHome;
      await rm(isolatedHome, { recursive: true, force: true });
    }
  });

  it('replays consecutive output events and flushes batches before target breaks', async () => {
    await backend.boot();

    const replayState = await backend.replayTo(
      createReplayInput(
        [
          {
            seq: 0,
            ts: timestampFor(0),
            type: 'output',
            payload: { data: 'hello ' },
          },
          {
            seq: 1,
            ts: timestampFor(1),
            type: 'output',
            payload: { data: 'from ' },
          },
          {
            seq: 2,
            ts: timestampFor(2),
            type: 'output',
            payload: { data: 'replay\r\n' },
          },
          {
            seq: 3,
            ts: timestampFor(3),
            type: 'output',
            payload: { data: 'should not be applied\r\n' },
          },
        ],
        { targetSeq: 2 },
      ),
    );

    const snapshot = await backend.snapshot();
    const visibleText = snapshot.visibleLines
      .map((line) => line.text)
      .join('\n');

    expect(replayState.lastSeq).toBe(2);
    expect(snapshot.capturedAtSeq).toBe(2);
    expect(visibleText).toContain('hello from replay');
    expect(visibleText).not.toContain('should not be applied');
  });

  it('flushes output batches before resize events and preserves dimensions', async () => {
    await backend.boot();

    const replayState = await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'before resize\r\n' },
        },
        {
          seq: 1,
          ts: timestampFor(1),
          type: 'resize',
          payload: { cols: 40, rows: 12 },
        },
        {
          seq: 2,
          ts: timestampFor(2),
          type: 'output',
          payload: { data: 'after resize\r\n' },
        },
      ]),
    );

    const snapshot = await backend.snapshot();
    const visibleText = snapshot.visibleLines
      .map((line) => line.text)
      .join('\n');

    expect(replayState.lastSeq).toBe(2);
    expect(replayState.cols).toBe(40);
    expect(replayState.rows).toBe(12);
    expect(snapshot.cols).toBe(40);
    expect(snapshot.rows).toBe(12);
    expect(visibleText).toContain('before resize');
    expect(visibleText).toContain('after resize');
  });

  it('ignores non-rendering replay event types without failing', async () => {
    await backend.boot();

    const replayState = await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'before ignored events\r\n' },
        },
        {
          seq: 1,
          ts: timestampFor(1),
          type: 'input_text',
          payload: { data: 'typed text' },
        },
        {
          seq: 2,
          ts: timestampFor(2),
          type: 'input_keys',
          payload: { keys: ['Enter'] },
        },
        {
          seq: 3,
          ts: timestampFor(3),
          type: 'signal',
          payload: { signal: 'SIGUSR1' },
        },
      ]),
    );

    const snapshot = await backend.snapshot();

    expect(replayState.lastSeq).toBe(3);
    expect(
      snapshot.visibleLines.some((line) =>
        line.text.includes('before ignored events'),
      ),
    ).toBe(true);
  });

  it('returns visible text for the current viewport', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'visible text marker\r\nsecond line\r\n' },
        },
      ]),
    );

    const visibleText = await backend.getVisibleText();

    expect(visibleText).toContain('visible text marker');
    expect(visibleText).toContain('second line');
  });

  it('returns no scrollbackLines by default', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'hello\r\n' },
        },
      ]),
    );

    const snapshot = await backend.snapshot();

    expect(snapshot.scrollbackLines).toBeUndefined();
  });

  it('supports includeScrollback snapshots for overflow output', async () => {
    await backend.boot();
    const lines = Array.from(
      { length: 50 },
      (_, index) => `line-${String(index)}\r\n`,
    ).join('');
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: lines },
        },
      ]),
    );

    const snapshot = await backend.snapshot({ includeScrollback: true });

    expect(snapshot.visibleLines.length).toBeGreaterThan(0);
    expect(
      snapshot.visibleLines.some((line) => line.text.includes('line-49')),
    ).toBe(true);

    expect(snapshot.scrollbackLines).toBeDefined();
    const scrollbackLines = snapshot.scrollbackLines;
    if (scrollbackLines === undefined) {
      throw new Error('expected scrollback lines');
    }
    expect(scrollbackLines).not.toHaveLength(0);
    expect(scrollbackLines[0]?.row).toBe(0);
    for (let index = 1; index < scrollbackLines.length; index += 1) {
      expect(scrollbackLines[index]?.row).toBeGreaterThan(
        scrollbackLines[index - 1]?.row ?? -1,
      );
    }
    expect(
      scrollbackLines.length + snapshot.visibleLines.length,
    ).toBeGreaterThanOrEqual(50);
    const allScrollbackText = scrollbackLines
      .map((line) => line.text)
      .join('\n');
    expect(allScrollbackText).toContain('line-0');
  });

  it('recovers state after dispose and re-boot', async () => {
    const expectedText = 'hello from renderer';
    const replayInput = createReplayInput([
      {
        seq: 0,
        ts: timestampFor(0),
        type: 'output',
        payload: { data: `${expectedText}\r\n` },
      },
    ]);
    // oxfmt-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-restart-')));
    const screenshotAPath = join(outputDir, 'renderer-a.png');
    const screenshotBPath = join(outputDir, 'renderer-b.png');

    try {
      expect(backend.isBooted).toBe(false);
      await backend.boot();
      expect(backend.isBooted).toBe(true);

      const replayStateA = await backend.replayTo(replayInput);
      expect(replayStateA.lastSeq).toBe(replayInput.targetSeq);

      const screenshotA = await backend.screenshot(screenshotAPath);
      expect(screenshotA.artifactPath).toBe(screenshotAPath);
      expect(screenshotA.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(screenshotA.pngSizeBytes).toBeGreaterThan(0);
      const screenshotABuffer = await readValidPngFile(
        screenshotAPath,
        'screenshotA PNG',
      );
      expect(screenshotABuffer.length).toBe(screenshotA.pngSizeBytes);

      const snapshotA = await backend.snapshot();
      const visibleTextA = visibleTextFromSnapshot(snapshotA);
      expect(snapshotA.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(visibleTextA).toContain(expectedText);

      await backend.dispose();
      expect(backend.isBooted).toBe(false);

      await backend.boot();
      expect(backend.isBooted).toBe(true);

      const replayStateB = await backend.replayTo(replayInput);
      expect(replayStateB.lastSeq).toBe(replayInput.targetSeq);

      const screenshotB = await backend.screenshot(screenshotBPath);
      expect(screenshotB.artifactPath).toBe(screenshotBPath);
      expect(screenshotB.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(screenshotB.pngSizeBytes).toBeGreaterThan(0);
      const screenshotBBuffer = await readValidPngFile(
        screenshotBPath,
        'screenshotB PNG',
      );
      expect(screenshotBBuffer.length).toBe(screenshotB.pngSizeBytes);

      const snapshotB = await backend.snapshot();
      const visibleTextB = visibleTextFromSnapshot(snapshotB);
      expect(snapshotB.capturedAtSeq).toBe(replayInput.targetSeq);
      expect(visibleTextB).toContain(expectedText);
      expect(visibleTextB).toBe(visibleTextA);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('captures screenshots to disk', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'screenshot marker\r\n' },
        },
      ]),
    );

    // oxfmt-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-shot-')));
    const outputPath = join(outputDir, 'renderer.png');

    try {
      const screenshot = await backend.screenshot(outputPath);
      const fileStats = await stat(outputPath);

      expect(screenshot.artifactPath).toBe(outputPath);
      expect(screenshot.pngSizeBytes).toBeGreaterThan(0);
      expect(fileStats.size).toBe(screenshot.pngSizeBytes);
      expect(screenshot.renderProfileHash).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('draws the block cursor in a screenshot only when showCursor is true', async () => {
    const prompt = 'READY> ';
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: prompt },
        },
      ]),
    );

    // The program hid the cursor itself (DECTCEM), so no block is painted
    // whatever the screenshot option says. That makes it the reference for
    // "no cursor block".
    const referenceBackend = new GhosttyWebBackend(
      `${SESSION_ID}-no-cursor`,
      PROFILE,
    );
    // oxfmt-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-cursor-')));

    try {
      await referenceBackend.boot();
      await referenceBackend.replayTo(
        createReplayInput(
          [
            {
              seq: 0,
              ts: timestampFor(0),
              type: 'output',
              payload: { data: `${prompt}\u001b[?25l` },
            },
          ],
          { sessionId: `${SESSION_ID}-no-cursor` },
        ),
      );
      const noCursor = await referenceBackend.screenshot(
        join(outputDir, 'no-cursor.png'),
        { showCursor: true },
      );

      // Show first: the harness paints the cursor before any screenshot, so
      // the hide that follows has to erase a block that is already on canvas.
      const shown = await backend.screenshot(join(outputDir, 'shown.png'), {
        showCursor: true,
      });
      const hidden = await backend.screenshot(join(outputDir, 'hidden.png'), {
        showCursor: false,
      });
      const byDefault = await backend.screenshot(
        join(outputDir, 'default.png'),
      );
      const shownAgain = await backend.screenshot(
        join(outputDir, 'shown-again.png'),
        { showCursor: true },
      );

      expect(shown.cursorVisible).toBe(true);
      expect(hidden.cursorVisible).toBe(false);
      expect(byDefault.cursorVisible).toBe(false);
      expect(hidden.sha256).toBe(noCursor.sha256);
      expect(byDefault.sha256).toBe(noCursor.sha256);
      expect(shown.sha256).not.toBe(hidden.sha256);
      expect(shownAgain.sha256).toBe(shown.sha256);
    } finally {
      await referenceBackend.dispose();
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('reports glyphs that no font draws as missingGlyphs, and the check leaves the PNG unchanged', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: { data: 'ok \ue0b0 \u0378\r\n\u0378 end\r\n' },
        },
      ]),
    );

    // oxfmt-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-glyphs-')));

    try {
      const first = await backend.screenshot(join(outputDir, 'first.png'));
      const second = await backend.screenshot(join(outputDir, 'second.png'));

      expect(first.missingGlyphs).toEqual([
        {
          codePoint: 'U+0378',
          cells: [
            { row: 0, col: 5 },
            { row: 1, col: 0 },
          ],
        },
      ]);
      expect(second.missingGlyphs).toEqual(first.missingGlyphs);
      expect(second.sha256).toBe(first.sha256);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('does not list the spaces that the PNG draws blank', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: {
            data: '1\u202f234\u202f567,5 a\u2009b\u2007c\u205fd\u3000e\r\n',
          },
        },
      ]),
    );
    // oxfmt-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-spaces-')));

    try {
      const shot = await backend.screenshot(join(outputDir, 'spaces.png'));

      expect(shot.missingGlyphs).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('lists a glyph the same way whatever glyphs sit next to it', async () => {
    // oxfmt-ignore
    const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-tty-renderer-neighbors-')));
    const listed = async (text: string, name: string): Promise<string[]> => {
      const renderer = new GhosttyWebBackend(SESSION_ID, PROFILE);
      try {
        await renderer.boot();
        await renderer.replayTo(
          createReplayInput([
            {
              seq: 0,
              ts: timestampFor(0),
              type: 'output',
              payload: { data: `${text}\r\n` },
            },
          ]),
        );
        const shot = await renderer.screenshot(join(outputDir, `${name}.png`));
        return (shot.missingGlyphs ?? []).map((glyph) => glyph.codePoint);
      } finally {
        await renderer.dispose();
      }
    };

    try {
      const alone = await listed('\u2500 \u2713 \u2631 \u2502', 'alone');
      const nextToBoxes = await listed(
        '\u0378\u2500\u0378\u2713\u0378\u2631\u0378\u2502\u0378',
        'next-to-boxes',
      );

      expect(nextToBoxes).toEqual(['U+0378', ...alone]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('checks a glyph against the face that drew it when one family has two faces', async () => {
    const [jetBrains, symbols] = PROFILE.fontAssets ?? [];
    if (jetBrains === undefined || symbols === undefined) {
      throw new Error('the reference profile must bundle two fonts');
    }
    const profile = {
      ...PROFILE,
      name: 'two-faces',
      fontFamily: '"Term", monospace',
      fontAssets: [
        { ...jetBrains, family: 'Term', weight: '400' },
        { ...symbols, family: 'Term', weight: '700' },
      ],
    };

    expect(await listedGlyphs(profile, 'x \ue0b0 y')).toEqual(['U+E0B0']);
  });

  it('finds the drawing face when the profile gives its family another name', async () => {
    const [jetBrains] = PROFILE.fontAssets ?? [];
    if (jetBrains === undefined) {
      throw new Error('the reference profile must bundle JetBrains Mono');
    }
    const profile = {
      ...PROFILE,
      name: 'aliased-family',
      fontFamily: '"Term Mono", monospace',
      fontAssets: [{ ...jetBrains, family: 'Term Mono' }],
    };

    expect(await listedGlyphs(profile, 'x \u0378 y')).toEqual(['U+0378']);
  });

  it('lists the part of a cluster that the font drawing it lacks', async () => {
    expect(await listedGlyphs(PROFILE, 'x \ue0b0\u0301 y')).toEqual(['U+E0B0']);
  });

  it('counts a bundled font that the stack names after the generic family', async () => {
    const profile = {
      ...PROFILE,
      name: 'symbols-after-generic',
      fontFamily: '"JetBrains Mono", monospace, "Symbols Nerd Font Mono"',
    };

    expect(await listedGlyphs(profile, 'x \ue0b0 \u0378 y')).toEqual([
      'U+0378',
    ]);
  });

  it('draws math and legacy-computing symbols with the bundled Noto fonts', async () => {
    expect(await listedGlyphs(PROFILE, 'x \u29c9 \u{1fb00} \u0378 y')).toEqual([
      'U+0378',
    ]);
  });

  it('reports the font of every probe text, right after the probe spans appear', async () => {
    await backend.boot();
    await backend.replayTo(
      createReplayInput([
        { seq: 0, ts: timestampFor(0), type: 'output', payload: { data: 'x' } },
      ]),
    );
    const { page } = backend as unknown as { page: Page };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fonts = await probeUsedFonts(
        page,
        `${String(PROFILE.fontSize)}px ${PROFILE.fontFamily}`,
        ['A', '\ue0b0'],
      );

      expect(fonts.get('A')).toEqual([
        {
          familyName: 'JetBrains Mono',
          postScriptName: 'JetBrainsMono-Regular',
          isCustomFont: true,
        },
      ]);
      expect(fonts.get('\ue0b0')).toEqual([
        {
          familyName: 'Symbols Nerd Font Mono',
          postScriptName: 'SymbolsNFM',
          isCustomFont: true,
        },
      ]);
    }
  });

  // ghostty-web calls a write callback one animation frame (about 17 ms)
  // after the write. A bridge call that waits on every chunk made a replay cost
  // one frame per output event: 90 minutes for 250 000 events.
  it.each([
    [
      'replayTo',
      (renderer: GhosttyWebBackend, input: ReplayInput) =>
        renderer.replayTo(input),
    ],
    [
      'replayWithTiming',
      (renderer: GhosttyWebBackend, input: ReplayInput) =>
        renderer.replayWithTiming(input, {
          mode: 'max-speed',
          minFrameHoldMs: 0,
          finalFrameHoldMs: 0,
        }),
    ],
  ])(
    '%s waits for one animation frame per flush of output events, not per event',
    async (_name, replay) => {
      await backend.boot();
      const { page } = backend as unknown as { page: Page };
      // ghostty-web calls a write callback one frame after the write, so the
      // number of writes that pass a callback is the number of frames that a
      // replay waits for. The string keeps vitest from rewriting the import.
      await page.evaluate(`(async () => {
        const { Terminal } = await import('/assets/ghostty-web.js');
        const write = Terminal.prototype.write;
        globalThis.__writeFrameWaits = 0;
        Terminal.prototype.write = function (data, callback) {
          if (callback !== undefined) {
            globalThis.__writeFrameWaits += 1;
          }
          return write.call(this, data, callback);
        };
      })()`);

      // One character per event, so a chunk that is lost or moved changes
      // the text on the screen. 2501 characters fill 32 rows of 80 columns.
      const characters = Array.from({ length: 2_501 }, (_, seq) =>
        'abcdefghijklmnopqrstuvwxyz0123456789'.charAt((seq * 7) % 36),
      );
      const input = createReplayInput(
        characters.map((character, seq) => ({
          seq,
          ts: timestampFor(0),
          type: 'output' as const,
          payload: { data: character },
        })),
        { initialRows: 40 },
      );
      await replay(backend, input);

      // A bridge call holds at most 1000 chunks, so 2501 events take 3 calls.
      // Only the last call waits for a frame.
      expect(
        await page.evaluate(
          () =>
            (globalThis as unknown as { __writeFrameWaits: number })
              .__writeFrameWaits,
        ),
      ).toBe(1);
      const expectedRows = Array.from({ length: 32 }, (_, row) =>
        characters.slice(row * 80, (row + 1) * 80).join(''),
      );
      const screenRows = (await backend.snapshot()).visibleLines.map(
        (line) => line.text,
      );
      expect(screenRows.slice(0, 32)).toEqual(expectedRows);
    },
  );

  // ghostty-web paints on every animation frame, and a WebM records every
  // paint. A flush of more than 1000 chunks takes several page calls, so a
  // state that exists between two calls can reach the video.
  it.each([
    [
      'replayTo',
      (renderer: GhosttyWebBackend, input: ReplayInput) =>
        renderer.replayTo(input),
    ],
    [
      'replayWithTiming',
      (renderer: GhosttyWebBackend, input: ReplayInput) =>
        renderer.replayWithTiming(input, {
          mode: 'max-speed',
          minFrameHoldMs: 16,
          finalFrameHoldMs: 200,
        }),
    ],
  ])(
    '%s paints a flush of several page calls as one frame',
    async (_name, replay) => {
      await backend.boot();
      const { page } = backend as unknown as { page: Page };
      // The screencast is the source of the frames that Playwright encodes into
      // a video: it sends a frame for every paint.
      const screencast = await page.context().newCDPSession(page);
      const frames: string[] = [];
      screencast.on('Page.screencastFrame', (frame) => {
        const hash = createHash('sha256').update(frame.data).digest('hex');
        if (frames.at(-1) !== hash) {
          frames.push(hash);
        }
        void screencast
          .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
          .catch(() => {});
      });
      await screencast.send('Page.startScreencast', {
        format: 'png',
        everyNthFrame: 1,
      });

      // Each bridge call of 1000 chunks fills the screen with its own colour
      // (red, green, blue), so a paint between two calls shows a colour that is
      // not the last. A pause after each call stands for a slow host.
      const backgroundFor = (seq: number): number =>
        [41, 42, 44][Math.floor(seq / 1_000)] ?? 44;
      const input = createReplayInput(
        Array.from({ length: 2_501 }, (_, seq) => ({
          seq,
          ts: timestampFor(0),
          type: 'output' as const,
          payload: { data: `\u001b[${String(backgroundFor(seq))}m\u001b[2J` },
        })),
      );
      const writeBatchBridge = (
        backend as unknown as {
          writeBatchBridge: (...args: unknown[]) => Promise<void>;
        }
      ).writeBatchBridge.bind(backend);
      Object.assign(backend as object, {
        writeBatchBridge: async (...args: unknown[]) => {
          await writeBatchBridge(...args);
          await new Promise((resolve) => setTimeout(resolve, 100));
        },
      });
      // Wait for the first frame, so that it is the screen before the replay.
      await expect
        .poll(() => frames.length, { timeout: 10_000 })
        .toBeGreaterThan(0);
      await replay(backend, input);
      // Let every frame that the replay caused reach the listener.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await screencast.send('Page.stopScreencast');

      // The frame before the replay, then the frame of the last colour.
      expect(frames).toHaveLength(2);
    },
  );

  it('holds the chunks of a flush until the call that ends it', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    const visibleFirstRow = (): Promise<string> =>
      page.evaluate(
        `window.__agentTty.getVisibleText().split('\\n')[0]`,
      ) as Promise<string>;
    await page.evaluate('window.__agentTty.resize(80, 24)');

    await page.evaluate(`window.__agentTty.writeBatch(['ab'], false)`);
    await page.evaluate(`window.__agentTty.writeBatch(['cd'], false)`);
    expect(await visibleFirstRow()).toBe('');

    // A direct write or a resize would move the held chunks behind its own
    // output, so the page refuses both.
    await expect(page.evaluate(`window.__agentTty.write('x')`)).rejects.toThrow(
      'holds the chunks of a flush',
    );
    await expect(
      page.evaluate(`window.__agentTty.resize(100, 30)`),
    ).rejects.toThrow('holds the chunks of a flush');
    expect(await visibleFirstRow()).toBe('');

    await page.evaluate(`window.__agentTty.writeBatch(['ef'], true)`);
    expect(await visibleFirstRow()).toBe('abcdef');
  });

  it('allows dispose to be called more than once', async () => {
    await backend.boot();

    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
    expect(backend.isBooted).toBe(false);
  });
});
