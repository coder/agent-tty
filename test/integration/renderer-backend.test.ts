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
import { PER_ROW_DECODE } from '../helpers/perRowDecode.js';

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

// The harness decode starts with terminal.scrollToBottom(). Patching it keeps
// the terminal in globalThis.__decodedTerminal for PER_ROW_DECODE. The string
// keeps vitest from rewriting the import.
async function keepDecodedTerminal(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    return import('/assets/ghostty-web.js').then(({ Terminal }) => {
      const scrollToBottom = Terminal.prototype.scrollToBottom;
      Terminal.prototype.scrollToBottom = function () {
        globalThis.__decodedTerminal = this;
        return scrollToBottom.call(this);
      };
      window.__agentTty.getVisibleText();
    });
  })()`);
}

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
      // Wait until the screen before the replay is quiet: a slow host can
      // deliver a late paint of the first screen, which is not a frame of the
      // replay. The screen before the replay counts as one frame.
      let framesSeen = 0;
      let quietSinceMs = Date.now();
      await expect
        .poll(
          () => {
            if (frames.length !== framesSeen) {
              framesSeen = frames.length;
              quietSinceMs = Date.now();
            }
            return framesSeen > 0 && Date.now() - quietSinceMs >= 300;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const framesBefore = frames.length;
      await replay(backend, input);
      // The last colour must reach the listener. Then wait a little more, so
      // that a frame between two calls would have arrived too.
      await expect
        .poll(() => frames.length, { timeout: 10_000 })
        .toBeGreaterThan(framesBefore);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await screencast.send('Page.stopScreencast');

      // The screen before the replay, then the frame of the last colour.
      expect(frames).toHaveLength(framesBefore + 1);
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

  // HostRendererManager keeps the backend after a failed replay and retries
  // from the same seq. The page held the chunks of the calls before the one
  // that failed, so a retry that started with a resize was refused for good.
  it('runs a retry that starts with a resize after a page call failed in the middle of a flush', async () => {
    await backend.boot();
    // One character per event, so a chunk that is lost, repeated or moved
    // changes the text on the screen. 2501 characters fill 32 rows of 80
    // columns.
    const characters = Array.from({ length: 2_501 }, (_, index) =>
      'abcdefghijklmnopqrstuvwxyz0123456789'.charAt((index * 7) % 36),
    );
    const outputs = (firstSeq: number): ReplayInput['events'] =>
      characters.map((character, index) => ({
        seq: firstSeq + index,
        ts: timestampFor(0),
        type: 'output' as const,
        payload: { data: character },
      }));
    const writeBatchBridge = (
      backend as unknown as {
        writeBatchBridge: (...args: unknown[]) => Promise<void>;
      }
    ).writeBatchBridge.bind(backend);
    let pageCalls = 0;
    Object.assign(backend as object, {
      writeBatchBridge: async (...args: unknown[]) => {
        pageCalls += 1;
        if (pageCalls === 2) {
          throw new Error('page call failed');
        }
        await writeBatchBridge(...args);
      },
    });

    await expect(
      backend.replayTo(createReplayInput(outputs(0))),
    ).rejects.toThrow('page call failed');

    Object.assign(backend as object, { writeBatchBridge });
    await backend.replayTo(
      createReplayInput(
        [
          {
            seq: 0,
            ts: timestampFor(0),
            type: 'resize',
            payload: { cols: 80, rows: 40 },
          },
          ...outputs(1),
        ],
        { initialRows: 24 },
      ),
    );

    const expectedRows = Array.from({ length: 32 }, (_, row) =>
      characters.slice(row * 80, (row + 1) * 80).join(''),
    );
    const screenRows = (await backend.snapshot()).visibleLines.map(
      (line) => line.text,
    );
    expect(screenRows.slice(0, 32)).toEqual(expectedRows);
  });

  // A flush of 1001 chunks takes two page calls, and the glyph that it paints
  // comes with its last chunk. The next flush erases it.
  it('records the glyphs that a flush painted, in the page call that ends the flush', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    const pageFunctions: string[] = [];
    const evaluate = page.evaluate.bind(page) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    Object.assign(page, {
      evaluate: (pageFunction: unknown, ...rest: unknown[]) => {
        pageFunctions.push(String(pageFunction));
        return evaluate(pageFunction, ...rest);
      },
    });

    await backend.replayWithTiming(
      createReplayInput([
        ...Array.from({ length: 1_000 }, (_, seq) => ({
          seq,
          ts: timestampFor(0),
          type: 'output' as const,
          payload: { data: 'x' },
        })),
        {
          seq: 1_000,
          ts: timestampFor(0),
          type: 'output' as const,
          payload: { data: '\u0378' },
        },
        {
          seq: 1_001,
          ts: timestampFor(1),
          type: 'output' as const,
          payload: { data: '\u001b[2J\u001b[Hok' },
        },
      ]),
      { mode: 'max-speed', minFrameHoldMs: 16, finalFrameHoldMs: 200 },
    );

    await expect(backend.recordedMissingGlyphs()).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+0378' }],
    });
    // 1001 chunks take 2 calls, the next flush takes 1. None of them has a
    // call of its own for the note.
    expect(
      pageFunctions.filter((source) => source.includes('writeBatch')),
    ).toHaveLength(3);
    expect(
      pageFunctions.filter((source) => source.includes('notePaintedGraphemes')),
    ).toHaveLength(0);
  });

  it('writes a flush even when its painted-grapheme note fails, and reports the failure', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    await page.evaluate('window.__agentTty.resize(80, 24)');

    // A cap of 0 makes the note throw after the chunks are on the screen.
    const noteError = await page.evaluate(
      `window.__agentTty.writeBatch(['ab', 'cd'], true, 0)`,
    );

    expect(noteError).toEqual(
      expect.stringContaining('cap must be a positive integer'),
    );
    expect(
      await page.evaluate(`window.__agentTty.getVisibleText().split('\\n')[0]`),
    ).toBe('abcd');
  });

  // A resize can bring graphemes on the screen that no flush showed: growing
  // the screen pulls lines back from the scrollback. The note that follows the
  // resize records them, and the next flush then erases the screen.
  it('records a glyph that a resize brings back from the scrollback', async () => {
    await backend.boot();

    await backend.replayWithTiming(
      createReplayInput([
        {
          seq: 0,
          ts: timestampFor(0),
          type: 'output',
          payload: {
            data: `\u0378\r\n${Array.from({ length: 30 }, (_, line) => `line ${String(line)}\r\n`).join('')}`,
          },
        },
        {
          seq: 1,
          ts: timestampFor(1),
          type: 'resize',
          payload: { cols: 80, rows: 40 },
        },
        {
          seq: 2,
          ts: timestampFor(2),
          type: 'output',
          payload: { data: '\u001b[2J\u001b[Hok' },
        },
      ]),
      { mode: 'max-speed', minFrameHoldMs: 16, finalFrameHoldMs: 200 },
    );

    await expect(backend.recordedMissingGlyphs()).resolves.toEqual({
      missingGlyphs: [{ codePoint: 'U+0378' }],
    });
  });

  // The page keeps the size attributes of the body (data-cols, data-rows) in
  // step with the terminal after every write. The call that ends a flush does
  // it too, as write() does.
  it('refreshes the size attributes of the document when a flush ends', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    await page.evaluate('window.__agentTty.resize(80, 24)');
    const sizeAttributes = (): Promise<string> =>
      page.evaluate(
        `document.body.dataset.cols + 'x' + document.body.dataset.rows`,
      ) as Promise<string>;
    expect(await sizeAttributes()).toBe('80x24');
    await page.evaluate(
      `document.body.dataset.cols = 'stale'; document.body.dataset.rows = 'stale'`,
    );

    await page.evaluate(`window.__agentTty.writeBatch(['ab'], false)`);
    expect(await sizeAttributes()).toBe('stalexstale');
    await page.evaluate(`window.__agentTty.writeBatch(['cd'], true)`);

    expect(await sizeAttributes()).toBe('80x24');
  });

  // The set of painted graphemes feeds a probe of every grapheme in it. The
  // cap that the backend passes bounds the set, and a set that hit the cap is
  // reported as incomplete, so the export result says that its list is cut.
  it('bounds the painted graphemes by the cap of the call that ends a flush', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    await page.evaluate('window.__agentTty.resize(80, 24)');
    const painted = (): Promise<{ seen: string[]; complete: boolean } | null> =>
      page.evaluate(
        `(() => {
          const state = window.__agentTtyPainted;
          return state === undefined ? null : { seen: [...state.seen], complete: state.complete };
        })()`,
      ) as Promise<{ seen: string[]; complete: boolean } | null>;

    // Nothing is noted while the call does not ask for it.
    await page.evaluate(`window.__agentTty.writeBatch(['abc'], true, null)`);
    expect(await painted()).toBeNull();

    await page.evaluate(
      `window.__agentTty.writeBatch(['\\x1b[2J\\x1b[Habc'], true, 5)`,
    );
    expect(await painted()).toEqual({ seen: ['a', 'b', 'c'], complete: true });

    await page.evaluate(
      `window.__agentTty.writeBatch(['\\x1b[2J\\x1b[Hdefgh'], true, 5)`,
    );
    expect(await painted()).toEqual({
      seen: ['a', 'b', 'c', 'd', 'e'],
      complete: false,
    });
  });

  // The scan of a flush reads the viewport once. The per-row decode reads it
  // row by row. Both must name the same grapheme in every cell, whatever the
  // screen holds and however it came to hold it.
  it('notes the graphemes of every cell as the per-row read names them', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    await keepDecodedTerminal(page);
    const noted = new Set<string>();
    const sizes: string[] = [];
    // Flushes the chunks, notes their graphemes, and returns the notes so far.
    const flush = async (chunks: string[]): Promise<string[]> =>
      page.evaluate(
        `(async () => {
          await window.__agentTty.writeBatch(${JSON.stringify(chunks)}, true, 1000);
          return [...window.__agentTtyPainted.seen];
        })()`,
      ) as Promise<string[]>;
    // The scan reads first, then the per-row decode reads the same screen. A
    // script runs before the scan, in the same task.
    const readGrids = (
      script = '',
    ): Promise<{ grid: string[][]; cells: string[][] }> =>
      page.evaluate(
        `(() => {
          ${script}
          const grid = window.__agentTty.getCellGraphemes();
          const reference = (${PER_ROW_DECODE})(globalThis.__decodedTerminal, false);
          return {
            grid,
            cells: reference.cells.map((line) => line.cells.map((cell) => cell.char)),
          };
        })()`,
      ) as Promise<{ grid: string[][]; cells: string[][] }>;
    const check = async (chunks: string[]): Promise<string[][]> => {
      const painted = await flush(chunks);
      const { grid, cells } = await readGrids();
      expect(grid).toEqual(cells);
      sizes.push(`${String(grid[0]?.length)}x${String(grid.length)}`);
      for (const grapheme of grid.flat()) {
        if (grapheme !== '') {
          noted.add(grapheme);
        }
      }
      expect(new Set(painted)).toEqual(noted);
      return grid;
    };
    // The scan runs in the task of the resize, before any frame updates the
    // render state, as the note after a resize event of a replay does.
    const resizeAndRead = async (cols: number, rows: number): Promise<void> => {
      const { grid, cells } = await readGrids(
        `window.__agentTty.resize(${String(cols)}, ${String(rows)});`,
      );
      expect(grid).toHaveLength(rows);
      expect(grid.every((row) => row.length === cols)).toBe(true);
      expect(grid).toEqual(cells);
    };

    await resizeAndRead(80, 24);
    // Narrow, wide, combining, joined and unassigned glyphs on one screen.
    const mixed = await check([
      '\u001b[2J\u001b[Habc \u65e5\u672c\u8a9e e\u0301 \u{1F469}\u200D\u{1F4BB} \u{1F1EF}\u{1F1F5}',
      '\r\n\u0915\u094D\u0937\u093F \u0378 \ue0b0 a\u0300\u0301 \u{1F44D}\u{1F3FD}',
    ]);
    expect(mixed[0]?.slice(0, 5)).toEqual(['a', 'b', 'c', ' ', '\u65e5']);
    // A wide glyph's trailing spacer cell has no grapheme.
    expect(mixed[0]?.[5]).toBe('');
    expect(noted).toContain('e\u0301');
    expect(noted).toContain('\u{1F469}\u200D\u{1F4BB}');
    expect(noted).toContain('\u0915\u094D');
    expect(noted).toContain('\u0937\u093F');
    expect(noted).toContain('\u0378');

    // Every row changes by scrolling, and no flush writes into a row.
    const scrolled = await check([
      Array.from({ length: 40 }, (_, line) => `line ${String(line)}`).join(
        '\r\n',
      ),
    ]);
    expect(scrolled[0]?.join('').trimEnd()).not.toBe(
      mixed[0]?.join('').trimEnd(),
    );

    // The other screen has its own cells and returns the first screen's.
    await check(['\u001b[?1049h\u001b[2J\u001b[Halt \u{1F600} \u00c5']);
    await check(['\u001b[?1049l']);

    // A write changes the wasm screen at once, and the render state follows
    // a frame later. A scan in the task of the write must not read the old
    // state.
    const fresh = await readGrids(
      `void window.__agentTty.write('\\u001b[2J\\u001b[Hsync');`,
    );
    expect(fresh.grid[0]?.slice(0, 4)).toEqual(['s', 'y', 'n', 'c']);
    expect(fresh.grid).toEqual(fresh.cells);

    // The cell pool of ghostty-web grows with the screen and does not shrink.
    // After a shrink its cells past the screen still hold the larger screen,
    // so the scan must index the viewport by the width of the screen.
    await resizeAndRead(120, 40);
    await check(['x'.repeat(120 * 40)]);
    await resizeAndRead(40, 10);
    await check(['\u001b[2J\u001b[Hsmall \u65e5\u672c \u{1F600}']);
    await resizeAndRead(100, 30);
    await check(['\u001b[2J\u001b[Hagain \u{1F1EF}\u{1F1F5}']);
    expect(sizes).toEqual([
      '80x24',
      '80x24',
      '80x24',
      '80x24',
      '120x40',
      '40x10',
      '100x30',
    ]);
  });

  // A snapshot and a wait poll read the viewport once. PER_ROW_DECODE reads it
  // row by row, as the harness did before. Both must give the same lines,
  // cells and text for every screen. The harness decodes first in every
  // comparison, so a read in the task of a write or a resize cannot lean on an
  // update that the per-row read made. The page compares the two decodes and
  // returns the differences: sending the cells of a large screen to the test
  // costs far more than decoding them.
  it('decodes the visible lines and cells as the per-row read of the same screen does', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    await keepDecodedTerminal(page);
    interface Cell {
      char: string;
      fg: string;
      bg: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
    }
    interface Comparison {
      cols: number;
      rows: number;
      scrollbackLength: number;
      differences: string[];
      cells: Cell[][];
    }
    const flush = async (chunks: string[]): Promise<void> => {
      await page.evaluate(
        `window.__agentTty.writeBatch(${JSON.stringify(chunks)}, true)`,
      );
    };
    // A script runs before the decodes, in the same task. The result holds the
    // cells of the top rows of the screen, for the checks of its content.
    const compare = async (script = '', topRows = 0): Promise<Comparison> => {
      const comparison = (await page.evaluate(
        `(() => {
          ${script}
          const text = window.__agentTty.getVisibleText();
          const actual = window.__agentTty.getSnapshot({
            includeScrollback: true,
            includeCells: true,
          });
          const expected = (${PER_ROW_DECODE})(globalThis.__decodedTerminal, true);
          const canon = (value) =>
            JSON.stringify(value, (key, item) =>
              item !== null && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(
                    Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
                  )
                : item,
            );
          const firstDifference = (name, left, right) => {
            if (left.length !== right.length) {
              return name + ': ' + left.length + ' rows against ' + right.length;
            }
            for (let row = 0; row < left.length; row += 1) {
              if (canon(left[row]) !== canon(right[row])) {
                return name + ' ' + row + ': ' + canon(left[row]).slice(0, 400) +
                  ' against ' + canon(right[row]).slice(0, 400);
              }
            }
            return null;
          };
          const differences = [
            actual.cols === expected.cols && actual.rows === expected.rows
              ? null
              : 'size',
            firstDifference('visibleLines', actual.visibleLines, expected.visibleLines),
            firstDifference('scrollbackLines', actual.scrollbackLines, expected.scrollbackLines),
            firstDifference('cells', actual.cells, expected.cells),
            text === expected.visibleLines.map((line) => line.text).join('\\n')
              ? null
              : 'text',
          ].filter((difference) => difference !== null);
          return {
            cols: actual.cols,
            rows: actual.rows,
            scrollbackLength: actual.scrollbackLines.length,
            differences,
            cells: actual.cells.slice(0, ${String(topRows)}).map((line) => line.cells),
          };
        })()`,
      )) as Comparison;
      expect(comparison.differences).toEqual([]);
      return comparison;
    };
    const cellAt = (grid: Cell[][], row: number, col: number): Cell => {
      const cell = grid[row]?.[col];
      if (cell === undefined) {
        throw new Error(
          `the screen has no cell at row ${String(row)} col ${String(col)}`,
        );
      }
      return cell;
    };
    const find = (
      grid: Cell[][],
      char: string,
    ): { row: number; col: number } => {
      for (const [row, line] of grid.entries()) {
        const col = line.findIndex((cell) => cell.char === char);
        if (col >= 0) {
          return { row, col };
        }
      }
      throw new Error(`the screen has no cell with ${JSON.stringify(char)}`);
    };

    // A blank screen, in the task of a resize that changes nothing.
    const blank = await compare('window.__agentTty.resize(80, 24);', 1);
    const blankCell = cellAt(blank.cells, 0, 79);
    expect(blankCell.char).toBe('');

    // Every style, narrow and wide glyphs, combining marks, joined emoji,
    // flags, Indic clusters, unassigned and private-use code points, half of a
    // wide glyph overwritten, and a wide glyph at the last column.
    await flush([
      '\u001b[2J\u001b[H',
      '\u001b[1mbold\u001b[22m \u001b[3mitalic\u001b[23m \u001b[4munder\u001b[24m \u001b[9mstrike\u001b[29m \u001b[2mfaint\u001b[22m\r\n',
      '\u001b[7minverse\u001b[27m \u001b[7;38;2;10;200;30;48;5;196mxcolour\u001b[0m \u001b[38;5;33;48;2;250;240;5mycolour\u001b[0m\r\n',
      '\u001b[1;3;4;9;31;44mall\u001b[0m \u65e5\u672c\u8a9e \u001b[1m\u6f22\u5b57\u001b[0m \u{1F469}\u200D\u{1F4BB} \u001b[43me\u0301\u001b[0m\r\n',
      '\u0915\u094D\u0937\u093F \u0378 \ue0b0 \u{1F1EF}\u{1F1F5} \u{1F44D}\u{1F3FD} \uff21\uff22\r\n',
      '\u{1F600}\u001b[1Dz  \u001b[5;80H\u65e5\u65e5',
      '\u001b[7;1H\ttab\t\u001b[5mblink\u001b[25m \u001b[8mhidden\u001b[28m',
    ]);
    const mixed = (await compare('', 8)).cells;
    expect(cellAt(mixed, 0, 0)).toMatchObject({ char: 'b', bold: true });
    expect(cellAt(mixed, 0, 5)).toMatchObject({ char: 'i', italic: true });
    expect(cellAt(mixed, 0, 12)).toMatchObject({ char: 'u', underline: true });
    expect(cellAt(mixed, 0, 18)).toMatchObject({
      char: 's',
      strikethrough: true,
    });
    // Inverse swaps the two colours.
    expect(cellAt(mixed, 1, 0)).toMatchObject({
      char: 'i',
      fg: blankCell.bg,
      bg: blankCell.fg,
    });
    expect(cellAt(mixed, 1, 8)).toMatchObject({ char: 'x', bg: '#0ac81e' });
    const wide = find(mixed, '\u65e5');
    expect(cellAt(mixed, wide.row, wide.col + 1).char).toBe('');
    expect(find(mixed, '\u{1F469}\u200D\u{1F4BB}').row).toBe(wide.row);
    expect(find(mixed, 'e\u0301').row).toBe(wide.row);
    expect(find(mixed, '\u0915\u094D').row).toBe(wide.row + 1);

    // Sixty lines scroll the first screen into the scrollback.
    await flush([
      Array.from(
        { length: 60 },
        (_, line) =>
          `line ${String(line)} \u001b[3${String(line % 8)}m\u65e5\u672c\u001b[0m e\u0301 \u001b[1mbold\u001b[0m`,
      ).join('\r\n'),
    ]);
    expect((await compare()).scrollbackLength).toBeGreaterThan(30);

    // The other screen has its own cells and returns the first screen's.
    await flush([
      '\u001b[?1049h\u001b[2J\u001b[Halt \u001b[7mscreen\u001b[0m \u{1F600} \u65e5',
    ]);
    expect(cellAt((await compare('', 1)).cells, 0, 0).char).toBe('a');
    await flush(['\u001b[?1049l']);
    await compare();

    // A write changes the wasm screen at once, and the render state follows a
    // frame later. A decode in the task of the write must not read the old
    // screen. The old screen has narrow cells where the new row has the
    // spacers of two wide glyphs, so an old width shows as extra spaces.
    const fresh = await compare(
      `void window.__agentTty.write('\\u001b[2J\\u001b[H\\u65e5\\u672cabc \\u001b[1;31msync\\u001b[0m');`,
      1,
    );
    expect(cellAt(fresh.cells, 0, 0).char).toBe('\u65e5');
    expect(cellAt(fresh.cells, 0, 1).char).toBe('');
    expect(cellAt(fresh.cells, 0, 8)).toMatchObject({ char: 's', bold: true });

    // The cell pool of ghostty-web grows with the screen and does not shrink.
    // After a shrink its cells past the screen still hold the larger screen,
    // so the decode must index the viewport by the width of the screen.
    const sizes: string[] = [];
    for (const [cols, rows, text] of [
      [120, 40, '\u001b[1mx\u001b[0m'],
      [40, 10, '\u65e5y'],
      [100, 30, '\u001b[7mz\u001b[0m\u{1F600}'],
      [200, 60, 'w'],
      [80, 24, '\u0301e'],
    ] as const) {
      const resized = await compare(
        `window.__agentTty.resize(${String(cols)}, ${String(rows)});`,
      );
      expect([resized.cols, resized.rows]).toEqual([cols, rows]);
      await flush([`\u001b[2J\u001b[H${text.repeat(cols * rows)}`]);
      const full = await compare();
      sizes.push(`${String(full.cols)}x${String(full.rows)}`);
    }
    expect(sizes).toEqual(['120x40', '40x10', '100x30', '200x60', '80x24']);
  });

  // ghostty-web's getChars() gives '' for codepoint 0 and a character for every
  // other value, U+FFFD for one that is no Unicode scalar value. A snapshot and
  // the scan must follow that rule, also for values that the terminal does not
  // write. The page plants the value in the first cell of the viewport read.
  it('says a cell with any codepoint but 0 has a character, as the per-row read does', async () => {
    await backend.boot();
    const { page } = backend as unknown as { page: Page };
    await keepDecodedTerminal(page);
    await page.evaluate(
      `window.__agentTty.writeBatch(["\\u001b[2J\\u001b[Hhello"], true)`,
    );

    const answers: Record<
      string,
      { cell: string; scan: string; reference: string }
    > = {};
    for (const codepoint of [
      0, 0x41, 0xd7ff, 0xd800, 0xdfff, 0xe000, 0x10ffff, 0x110000, 0x1fffff,
    ]) {
      answers[codepoint.toString(16)] = (await page.evaluate(
        `(() => {
          const wasmTerm = globalThis.__decodedTerminal.wasmTerm;
          const getViewport = wasmTerm.getViewport.bind(wasmTerm);
          wasmTerm.getViewport = () => {
            const cells = getViewport();
            cells[0].codepoint = ${String(codepoint)};
            return cells;
          };
          try {
            const snapshot = window.__agentTty.getSnapshot({ includeCells: true });
            const scan = window.__agentTty.getCellGraphemes();
            const reference = (${PER_ROW_DECODE})(globalThis.__decodedTerminal, false);
            return {
              cell: snapshot.cells[0].cells[0].char,
              scan: scan[0][0],
              reference: reference.cells[0].cells[0].char,
            };
          } finally {
            delete wasmTerm.getViewport;
          }
        })()`,
      )) as { cell: string; scan: string; reference: string };
    }

    // The grapheme of the first cell is 'h', whatever codepoint the planted
    // cell holds, so the answer is 'h' when the cell has a character.
    const hasCharacter = { cell: 'h', scan: 'h', reference: 'h' };
    const blank = { cell: '', scan: '', reference: '' };
    expect(answers).toEqual({
      '0': blank,
      '41': hasCharacter,
      d7ff: hasCharacter,
      d800: hasCharacter,
      dfff: hasCharacter,
      e000: hasCharacter,
      '10ffff': hasCharacter,
      '110000': hasCharacter,
      '1fffff': hasCharacter,
    });
  });

  it('allows dispose to be called more than once', async () => {
    await backend.boot();

    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
    expect(backend.isBooted).toBe(false);
  });
});
