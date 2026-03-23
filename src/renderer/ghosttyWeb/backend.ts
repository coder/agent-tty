import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';

import { invariant, assertString, unreachable } from '../../util/assert.js';
import type {
  AcceleratedTimingOptions,
  SnapshotOptions,
  VideoCapableRendererBackend,
  VideoRecordingOptions,
} from '../backend.js';
import type {
  RenderProfileConfig,
  ReplayInput,
  ReplayState,
  ScreenshotResult,
  SemanticSnapshot,
} from '../types.js';
import { hashProfile } from '../profiles.js';

interface GhosttyHarnessVisibleLine {
  row: number;
  text: string;
}

interface GhosttyHarnessSnapshot {
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  isAltScreen: boolean;
  visibleLines: GhosttyHarnessVisibleLine[];
  scrollbackLines?: GhosttyHarnessVisibleLine[];
}

interface GhosttyRequestAsset {
  body: Buffer;
  contentType: string;
}

interface GhosttyServedAsset extends GhosttyRequestAsset {
  contentSecurityPolicy?: string;
}

interface GhosttyBrowserBridge {
  isReady?: () => boolean;
  write?: (data: string) => Promise<void> | void;
  resize?: (cols: number, rows: number) => Promise<void> | void;
  getSnapshot?: (options?: SnapshotOptions) => GhosttyHarnessSnapshot;
  getVisibleText?: () => string;
}

interface GhosttyBrowserGlobal {
  __agentTerminal?: GhosttyBrowserBridge;
  document?: {
    body?: {
      dataset?: Record<string, string | undefined>;
    };
  };
}

const DEFAULT_PAGE_VIEWPORT = Object.freeze({
  height: 768,
  width: 1024,
});
const GHOSTTY_JAVASCRIPT_CONTENT_TYPE = 'text/javascript; charset=utf-8';
/**
 * The embedded ghostty-web harness currently needs a broader CSP than we would
 * prefer. `unsafe-inline` is required because the harness bootstraps
 * ghostty-web with an inline module script, and `unsafe-eval` is required by
 * the ghostty-web WASM module's dynamic code path. Current browsers do not make
 * `wasm-unsafe-eval` alone sufficient for this setup, so we keep both
 * directives and constrain the risk by serving the renderer only on the local
 * loopback interface; this harness is localhost-only infrastructure, not a
 * user-facing web surface.
 */
const HARNESS_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' data: blob:",
].join('; ');
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const WASM_CONTENT_TYPE = 'application/wasm';

const MAX_REPLAY_BATCH_SIZE = 1000;
const RAF_TIMEOUT_MS = 5_000;

const EMBEDDED_HARNESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
    />
    <title>agent-terminal ghostty-web harness</title>
    <style>
      :root {
        color-scheme: light dark;
      }

      * {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }

      html,
      body {
        margin: 0;
        padding: 0;
      }

      body {
        background: #000000;
        display: inline-block;
        font-synthesis: none;
        overflow: hidden;
      }

      #terminal-shell {
        display: inline-block;
        overflow: hidden;
      }

      #terminal {
        display: inline-block;
        line-height: 1;
      }

      canvas {
        display: block;
      }
    </style>
  </head>
  <body data-ready="false">
    <div id="terminal-shell">
      <div id="terminal"></div>
    </div>
    <script type="module">
      import { Terminal, init } from '/assets/ghostty-web.js';

      const DEFAULT_COLS = 80;
      const DEFAULT_ROWS = 24;
      const PROFILE_PARAM = 'profile';
      const terminalMount = document.getElementById('terminal');
      const terminalShell = document.getElementById('terminal-shell');

      function invariant(condition, message) {
        if (!condition) {
          throw new Error(message);
        }
      }

      function assertStringValue(value, message) {
        invariant(typeof value === 'string', message);
      }

      function assertNonEmptyString(value, message) {
        assertStringValue(value, message);
        invariant(value.length > 0, message);
      }

      function assertPositiveNumber(value, message) {
        invariant(typeof value === 'number' && Number.isFinite(value) && value > 0, message);
      }

      function assertPositiveInteger(value, message) {
        invariant(Number.isInteger(value) && value > 0, message);
      }

      function parseProfileFromLocation() {
        const url = new URL(window.location.href);
        const rawProfile = url.searchParams.get(PROFILE_PARAM);
        assertNonEmptyString(rawProfile, 'missing profile query parameter');

        let parsedProfile;
        try {
          parsedProfile = JSON.parse(rawProfile);
        } catch (error) {
          throw new Error(
            \`profile query parameter is not valid JSON: \${error instanceof Error ? error.message : String(error)}\`,
          );
        }

        invariant(parsedProfile !== null && typeof parsedProfile === 'object', 'profile must be an object');

        const profile = parsedProfile;
        assertNonEmptyString(profile.name, 'profile.name must be a non-empty string');
        invariant(profile.theme === 'dark' || profile.theme === 'light', 'profile.theme must be dark or light');
        assertNonEmptyString(profile.fontFamily, 'profile.fontFamily must be a non-empty string');
        assertPositiveNumber(profile.fontSize, 'profile.fontSize must be a positive number');
        invariant(
          profile.cursorStyle === 'block' ||
            profile.cursorStyle === 'bar' ||
            profile.cursorStyle === 'underline',
          'profile.cursorStyle must be block, bar, or underline',
        );
        invariant(
          typeof profile.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/u.test(profile.backgroundColor),
          'profile.backgroundColor must be a hex color',
        );
        invariant(
          typeof profile.foregroundColor === 'string' && /^#[0-9a-fA-F]{6}$/u.test(profile.foregroundColor),
          'profile.foregroundColor must be a hex color',
        );

        return Object.freeze({ ...profile });
      }

      const profile = parseProfileFromLocation();
      document.documentElement.style.colorScheme = profile.theme;
      document.body.style.background = profile.backgroundColor;
      document.body.style.color = profile.foregroundColor;
      document.body.style.fontFamily = profile.fontFamily;
      document.body.style.fontSize = \`\${profile.fontSize}px\`;
      terminalShell.style.background = profile.backgroundColor;
      terminalShell.style.color = profile.foregroundColor;
      terminalMount.style.background = profile.backgroundColor;
      terminalMount.style.color = profile.foregroundColor;
      terminalMount.style.fontFamily = profile.fontFamily;
      terminalMount.style.fontSize = \`\${profile.fontSize}px\`;

      const state = {
        errorMessage: null,
        ready: false,
        terminal: null,
      };

      function getReadyTerminal() {
        if (state.errorMessage !== null) {
          throw new Error(state.errorMessage);
        }

        invariant(state.ready, 'ghostty-web harness is not ready');
        invariant(state.terminal !== null, 'terminal instance is unavailable');
        invariant(state.terminal.wasmTerm, 'terminal WASM instance is unavailable');
        return state.terminal;
      }

      function getDimensions(terminal) {
        const wasmTerm = terminal.wasmTerm;
        invariant(wasmTerm, 'terminal WASM instance is unavailable');

        const dimensions = wasmTerm.getDimensions();
        assertPositiveInteger(dimensions.cols, 'terminal cols must be a positive integer');
        assertPositiveInteger(dimensions.rows, 'terminal rows must be a positive integer');
        invariant(dimensions.cols === terminal.cols, 'terminal cols drifted from WASM dimensions');
        invariant(dimensions.rows === terminal.rows, 'terminal rows drifted from WASM dimensions');
        return dimensions;
      }

      function getNormalizedViewportState(terminal) {
        const { cols, rows } = getDimensions(terminal);
        const activeBuffer = terminal.buffer.active;
        const viewportY = activeBuffer.viewportY;
        const bufferLength = activeBuffer.length;
        assertPositiveInteger(rows, 'visible row count must be positive');
        invariant(Number.isInteger(viewportY) && viewportY >= 0, 'viewportY must be a non-negative integer');
        invariant(
          Number.isInteger(bufferLength) && bufferLength >= rows,
          'active buffer length must cover the visible viewport',
        );

        const bottomViewportY = bufferLength - rows;
        invariant(bottomViewportY >= 0, 'bottom viewportY must be non-negative');
        invariant(
          viewportY <= bottomViewportY,
          'viewportY must not exceed the bottom viewport position',
        );

        return { cols, rows, activeBuffer, viewportY: bottomViewportY };
      }

      function decodeVisibleLines(terminal) {
        terminal.scrollToBottom();
        const { cols, rows, activeBuffer, viewportY } = getNormalizedViewportState(terminal);

        const visibleLines = [];
        for (let row = 0; row < rows; row += 1) {
          const line = activeBuffer.getLine(viewportY + row);
          const text = line === undefined ? '' : line.translateToString(true, 0, cols);
          invariant(typeof text === 'string', \`decoded line \${row} must be a string\`);
          visibleLines.push({ row, text });
        }

        invariant(visibleLines.length === rows, 'visible line count must match terminal rows');
        return { cols, rows, visibleLines };
      }

      function decodeScrollbackLines(terminal) {
        const { cols, activeBuffer, viewportY } = getNormalizedViewportState(terminal);

        if (viewportY === 0) {
          return [];
        }

        const scrollbackLines = [];
        for (let row = 0; row < viewportY; row += 1) {
          const line = activeBuffer.getLine(row);
          const text = line === undefined ? '' : line.translateToString(true, 0, cols);
          invariant(typeof text === 'string', \`decoded scrollback line \${row} must be a string\`);
          scrollbackLines.push({ row, text });
        }

        invariant(scrollbackLines.length === viewportY, 'scrollback line count must match viewportY');
        return scrollbackLines;
      }

      function getSnapshotPayload(options) {
        invariant(
          options === undefined || (options !== null && typeof options === 'object'),
          'snapshot options must be an object when provided',
        );
        invariant(
          options?.includeScrollback === undefined || typeof options.includeScrollback === 'boolean',
          'snapshot includeScrollback option must be a boolean when provided',
        );

        const terminal = getReadyTerminal();
        const wasmTerm = terminal.wasmTerm;
        invariant(wasmTerm, 'terminal WASM instance is unavailable');

        const cursor = wasmTerm.getCursor();
        const { cols, rows, visibleLines } = decodeVisibleLines(terminal);
        const scrollbackLines =
          options?.includeScrollback === true
            ? decodeScrollbackLines(terminal)
            : undefined;

        invariant(Number.isInteger(cursor.x) && cursor.x >= 0, 'cursor.x must be a non-negative integer');
        invariant(Number.isInteger(cursor.y) && cursor.y >= 0, 'cursor.y must be a non-negative integer');
        invariant(cursor.x < cols, 'cursor.x must be within the terminal width');
        invariant(cursor.y < rows, 'cursor.y must be within the terminal height');

        return {
          cols,
          rows,
          cursorCol: cursor.x,
          cursorRow: cursor.y,
          isAltScreen: wasmTerm.isAlternateScreen(),
          visibleLines,
          ...(scrollbackLines !== undefined && { scrollbackLines }),
        };
      }

      function updateDocumentState() {
        if (state.terminal === null || state.terminal.wasmTerm === undefined) {
          return;
        }

        const { cols, rows } = getDimensions(state.terminal);
        document.body.dataset.cols = String(cols);
        document.body.dataset.rows = String(rows);
      }

      window.__agentTerminal = {
        async write(data) {
          const terminal = getReadyTerminal();
          assertStringValue(data, 'write() data must be a string');

          await new Promise((resolve) => {
            terminal.write(data, resolve);
          });
          updateDocumentState();
        },
        getSnapshot(options) {
          return getSnapshotPayload(options);
        },
        getVisibleText() {
          return decodeVisibleLines(getReadyTerminal()).visibleLines.map((line) => line.text).join('\\n');
        },
        isReady() {
          return state.ready;
        },
        resize(cols, rows) {
          const terminal = getReadyTerminal();
          assertPositiveInteger(cols, 'resize() cols must be a positive integer');
          assertPositiveInteger(rows, 'resize() rows must be a positive integer');
          terminal.resize(cols, rows);
          updateDocumentState();
        },
      };

      async function boot() {
        await init();

        const terminal = new Terminal({
          allowTransparency: false,
          cols: DEFAULT_COLS,
          convertEol: false,
          cursorBlink: false,
          cursorStyle: profile.cursorStyle,
          disableStdin: true,
          fontFamily: profile.fontFamily,
          fontSize: profile.fontSize,
          rows: DEFAULT_ROWS,
          smoothScrollDuration: 0,
          theme: {
            background: profile.backgroundColor,
            cursor: profile.foregroundColor,
            cursorAccent: profile.backgroundColor,
            foreground: profile.foregroundColor,
          },
        });

        terminal.open(terminalMount);
        state.terminal = terminal;
        state.ready = true;
        document.body.dataset.ready = 'true';
        updateDocumentState();
      }

      void boot().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        state.errorMessage = \`ghostty-web harness failed to initialize: \${message}\`;
        state.ready = false;
        document.body.dataset.error = state.errorMessage;
        document.body.dataset.ready = 'false';
        terminalShell.textContent = state.errorMessage;
        console.error(error);
      });
    </script>
  </body>
</html>
`;

let servedAssetsPromise: Promise<
  ReadonlyMap<string, GhosttyServedAsset>
> | null = null;

function assertNonNegativeInteger(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value >= 0,
    message,
  );
}

function assertPositiveInteger(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isInteger(value) && value > 0,
    message,
  );
}

function assertPositiveNumber(
  value: unknown,
  message: string,
): asserts value is number {
  invariant(
    typeof value === 'number' && Number.isFinite(value) && value > 0,
    message,
  );
}

function assertHexColor(
  value: unknown,
  message: string,
): asserts value is string {
  assertString(value, message);
  invariant(/^#[0-9a-fA-F]{6}$/u.test(value), message);
}

function normalizeError(error: unknown, prefix: string): Error {
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`, { cause: error });
  }

  return new Error(`${prefix}: ${String(error)}`);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
        return;
      }

      rejectPromise(error);
    });
  });
}

async function loadHarnessHtml(): Promise<string> {
  // The embedded harness is the canonical runtime copy. Serving it directly keeps
  // snapshot extraction behavior in sync with the bridge implementation even when
  // the standalone source template drifts.
  return EMBEDDED_HARNESS_HTML;
}

async function loadServedAssets(): Promise<
  ReadonlyMap<string, GhosttyServedAsset>
> {
  const require = createRequire(import.meta.url);
  const ghosttyRequireEntry = require.resolve('ghostty-web');
  const ghosttyDistDirectory = dirname(ghosttyRequireEntry);
  const ghosttyPackageDirectory = resolve(ghosttyDistDirectory, '..');
  const ghosttyModulePath = join(
    ghosttyPackageDirectory,
    'dist',
    'ghostty-web.js',
  );
  const ghosttyWasmPath = join(
    ghosttyPackageDirectory,
    'dist',
    'ghostty-vt.wasm',
  );
  const ghosttyDistEntries = await readdir(
    join(ghosttyPackageDirectory, 'dist'),
  );
  const browserExternalEntries = ghosttyDistEntries.filter(
    (entryName) =>
      entryName.startsWith('__vite-browser-external-') &&
      entryName.endsWith('.js'),
  );

  invariant(
    browserExternalEntries.length === 1,
    'expected exactly one ghostty-web browser external helper, found ' +
      String(browserExternalEntries.length),
  );

  const [browserExternalEntry] = browserExternalEntries;
  invariant(
    browserExternalEntry !== undefined,
    'ghostty-web browser external helper must be present',
  );

  const browserExternalPath = join(
    ghosttyPackageDirectory,
    'dist',
    browserExternalEntry,
  );

  const harnessHtml = await loadHarnessHtml();
  const assetEntries = new Map<string, GhosttyServedAsset>();

  const htmlAsset: GhosttyServedAsset = {
    body: Buffer.from(harnessHtml, 'utf8'),
    contentSecurityPolicy: HARNESS_CONTENT_SECURITY_POLICY,
    contentType: HTML_CONTENT_TYPE,
  };
  assetEntries.set('/', htmlAsset);
  assetEntries.set('/harness.html', htmlAsset);

  const packageAssetEntries: ReadonlyArray<readonly [string, string, string]> =
    [
      [
        '/assets/ghostty-web.js',
        ghosttyModulePath,
        GHOSTTY_JAVASCRIPT_CONTENT_TYPE,
      ],
      [
        '/assets/' + browserExternalEntry,
        browserExternalPath,
        GHOSTTY_JAVASCRIPT_CONTENT_TYPE,
      ],
      ['/assets/ghostty-vt.wasm', ghosttyWasmPath, WASM_CONTENT_TYPE],
      ['/ghostty-vt.wasm', ghosttyWasmPath, WASM_CONTENT_TYPE],
    ];

  for (const [routePath, filePath, contentType] of packageAssetEntries) {
    const assetFile = await readFile(filePath);
    invariant(assetFile.byteLength > 0, `${routePath} asset must not be empty`);
    assetEntries.set(routePath, {
      body: assetFile,
      contentType,
    });
  }

  return assetEntries;
}

async function getServedAssets(): Promise<
  ReadonlyMap<string, GhosttyServedAsset>
> {
  servedAssetsPromise ??= loadServedAssets();
  return servedAssetsPromise;
}

function validateHarnessLines(
  lines: unknown,
  label: string,
  rowUpperBoundExclusive?: number,
): GhosttyHarnessVisibleLine[] {
  invariant(Array.isArray(lines), `${label}s must be an array`);

  const validatedLines: GhosttyHarnessVisibleLine[] = [];
  let previousRow = -1;
  for (const [index, lineValue] of lines.entries()) {
    const lineIndex = String(index);
    invariant(
      lineValue !== null && typeof lineValue === 'object',
      `${label} ${lineIndex} must be an object`,
    );

    const lineCandidate = lineValue as {
      row?: unknown;
      text?: unknown;
    };
    assertNonNegativeInteger(
      lineCandidate.row,
      `${label} ${lineIndex} row must be a non-negative integer`,
    );
    assertString(
      lineCandidate.text,
      `${label} ${lineIndex} text must be a string`,
    );
    if (rowUpperBoundExclusive !== undefined) {
      invariant(
        lineCandidate.row < rowUpperBoundExclusive,
        `${label} ${lineIndex} row must be within bounds`,
      );
    }
    invariant(
      lineCandidate.row > previousRow,
      `${label} ${lineIndex} rows must be strictly increasing`,
    );
    previousRow = lineCandidate.row;
    validatedLines.push({
      row: lineCandidate.row,
      text: lineCandidate.text,
    });
  }

  return validatedLines;
}

function validateHarnessSnapshot(snapshot: unknown): GhosttyHarnessSnapshot {
  invariant(
    snapshot !== null && typeof snapshot === 'object',
    'ghostty-web snapshot must be an object',
  );

  const candidate = snapshot as {
    cols?: unknown;
    rows?: unknown;
    cursorRow?: unknown;
    cursorCol?: unknown;
    isAltScreen?: unknown;
    visibleLines?: unknown;
    scrollbackLines?: unknown;
  };

  assertPositiveInteger(
    candidate.cols,
    'snapshot cols must be a positive integer',
  );
  assertPositiveInteger(
    candidate.rows,
    'snapshot rows must be a positive integer',
  );
  assertNonNegativeInteger(
    candidate.cursorRow,
    'snapshot cursorRow must be a non-negative integer',
  );
  assertNonNegativeInteger(
    candidate.cursorCol,
    'snapshot cursorCol must be a non-negative integer',
  );
  invariant(
    candidate.cursorRow < candidate.rows,
    'snapshot cursorRow must be within the terminal height',
  );
  invariant(
    candidate.cursorCol < candidate.cols,
    'snapshot cursorCol must be within the terminal width',
  );
  invariant(
    typeof candidate.isAltScreen === 'boolean',
    'snapshot isAltScreen must be a boolean',
  );

  const visibleLines = validateHarnessLines(
    candidate.visibleLines,
    'snapshot visible line',
    candidate.rows,
  );
  invariant(
    visibleLines.length <= candidate.rows,
    'snapshot visibleLines length must not exceed the viewport height',
  );

  const scrollbackLines =
    candidate.scrollbackLines === undefined
      ? undefined
      : validateHarnessLines(
          candidate.scrollbackLines,
          'snapshot scrollback line',
        );

  return {
    cols: candidate.cols,
    rows: candidate.rows,
    cursorRow: candidate.cursorRow,
    cursorCol: candidate.cursorCol,
    isAltScreen: candidate.isAltScreen,
    visibleLines,
    ...(scrollbackLines !== undefined && { scrollbackLines }),
  };
}

export class GhosttyWebBackend implements VideoCapableRendererBackend {
  public readonly rendererBackend = 'ghostty-web';
  public isBooted = false;

  private readonly profile: RenderProfileConfig;
  private readonly sessionId: string;
  private readonly videoOptions: Readonly<VideoRecordingOptions> | null;
  private bootPromise: Promise<void> | null = null;
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private currentCols: number | null = null;
  private currentRows: number | null = null;
  private disposePromise: Promise<void> | null = null;
  private expectedPageClosure = false;
  private failureReason: Error | null = null;
  private initialReplayCols: number | null = null;
  private initialReplayRows: number | null = null;
  private lastAppliedSeq = -1;
  private page: Page | null = null;
  private server: Server | null = null;
  private serverOrigin: string | null = null;

  public constructor(
    sessionId: string,
    profile: RenderProfileConfig,
    videoOptions?: VideoRecordingOptions,
  ) {
    invariant(sessionId.length > 0, 'sessionId must be a non-empty string');
    invariant(
      profile.name.length > 0,
      'profile.name must be a non-empty string',
    );
    invariant(
      profile.fontFamily.length > 0,
      'profile.fontFamily must be a non-empty string',
    );
    assertPositiveNumber(
      profile.fontSize,
      'profile.fontSize must be a positive number',
    );
    assertHexColor(
      profile.backgroundColor,
      'profile.backgroundColor must be a hex color',
    );
    assertHexColor(
      profile.foregroundColor,
      'profile.foregroundColor must be a hex color',
    );

    const normalizedVideoOptions =
      videoOptions === undefined
        ? null
        : (() => {
            invariant(
              videoOptions.outputDir.length > 0,
              'videoOptions.outputDir must be a non-empty string',
            );
            invariant(
              isAbsolute(videoOptions.outputDir),
              'videoOptions.outputDir must be an absolute path',
            );

            assertPositiveInteger(
              videoOptions.size.width,
              'videoOptions.size.width must be a positive integer',
            );
            assertPositiveInteger(
              videoOptions.size.height,
              'videoOptions.size.height must be a positive integer',
            );
            return Object.freeze({
              outputDir: videoOptions.outputDir,
              size: Object.freeze({
                width: videoOptions.size.width,
                height: videoOptions.size.height,
              }),
            });
          })();

    this.sessionId = sessionId;
    this.profile = Object.freeze({ ...profile });
    this.videoOptions = normalizedVideoOptions;
  }

  public async boot(): Promise<void> {
    if (this.isBooted) {
      return;
    }

    if (this.bootPromise !== null) {
      await this.bootPromise;
      return;
    }

    if (this.disposePromise !== null) {
      await this.disposePromise;
    }

    this.failureReason = null;
    this.bootPromise = this.bootInternal();
    await this.bootPromise;
  }

  public async replayTo(input: ReplayInput): Promise<ReplayState> {
    const page = this.requireOperationalPage('replayTo()');

    invariant(
      input.sessionId === this.sessionId,
      `replay input session ${input.sessionId} does not match backend session ${this.sessionId}`,
    );
    assertPositiveInteger(
      input.initialCols,
      'replay input initialCols must be a positive integer',
    );
    assertPositiveInteger(
      input.initialRows,
      'replay input initialRows must be a positive integer',
    );
    assertNonNegativeInteger(
      input.targetSeq,
      'replay input targetSeq must be a non-negative integer',
    );
    invariant(
      input.targetSeq >= this.lastAppliedSeq,
      'stateful GhosttyWebBackend cannot rewind from seq ' +
        String(this.lastAppliedSeq) +
        ' to ' +
        String(input.targetSeq),
    );

    if (this.initialReplayCols === null || this.initialReplayRows === null) {
      await this.resizeBridge(page, input.initialCols, input.initialRows);
      this.initialReplayCols = input.initialCols;
      this.initialReplayRows = input.initialRows;
      this.currentCols = input.initialCols;
      this.currentRows = input.initialRows;
    } else {
      invariant(
        this.initialReplayCols === input.initialCols &&
          this.initialReplayRows === input.initialRows,
        'replay input initial dimensions changed after the first replay',
      );
    }

    let previousEventSeq = -1;
    let highestProcessedSeq = this.lastAppliedSeq;
    let pendingOutputChunks: string[] = [];

    const flushOutputBatch = async (): Promise<void> => {
      if (pendingOutputChunks.length === 0) {
        return;
      }

      await this.flushOutputBatch(page, pendingOutputChunks);
      pendingOutputChunks = [];
    };

    for (const event of input.events) {
      assertNonNegativeInteger(
        event.seq,
        'replay event seq must be a non-negative integer',
      );
      invariant(
        event.seq > previousEventSeq,
        'replay events must be ordered by strictly increasing seq values',
      );
      previousEventSeq = event.seq;

      if (event.seq <= this.lastAppliedSeq) {
        continue;
      }

      if (event.seq > input.targetSeq) {
        await flushOutputBatch();
        break;
      }

      switch (event.type) {
        case 'output': {
          pendingOutputChunks.push(event.payload.data);
          break;
        }
        case 'resize': {
          await flushOutputBatch();
          assertPositiveInteger(
            event.payload.cols,
            'resize event cols must be a positive integer',
          );
          assertPositiveInteger(
            event.payload.rows,
            'resize event rows must be a positive integer',
          );
          await this.resizeBridge(page, event.payload.cols, event.payload.rows);
          this.currentCols = event.payload.cols;
          this.currentRows = event.payload.rows;
          break;
        }
        case 'marker': {
          await flushOutputBatch();
          break;
        }
        case 'input_text':
        case 'input_paste':
        case 'input_keys':
        case 'signal':
        case 'exit': {
          await flushOutputBatch();
          break;
        }
        default: {
          unreachable(event, 'unsupported replay event type');
        }
      }

      highestProcessedSeq = event.seq;
    }

    await flushOutputBatch();

    if (highestProcessedSeq < 0) {
      highestProcessedSeq = input.targetSeq;
    }

    this.lastAppliedSeq = highestProcessedSeq;

    const snapshot = await this.readHarnessSnapshot(page);
    this.currentCols = snapshot.cols;
    this.currentRows = snapshot.rows;

    return {
      lastSeq: this.lastAppliedSeq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursorRow: snapshot.cursorRow,
      cursorCol: snapshot.cursorCol,
    };
  }

  public async replayWithTiming(
    input: ReplayInput,
    options: AcceleratedTimingOptions,
  ): Promise<ReplayState> {
    const page = this.requireOperationalPage('replayWithTiming()');

    invariant(
      input.sessionId === this.sessionId,
      `replay input session ${input.sessionId} does not match backend session ${this.sessionId}`,
    );
    assertPositiveInteger(
      input.initialCols,
      'replay input initialCols must be a positive integer',
    );
    assertPositiveInteger(
      input.initialRows,
      'replay input initialRows must be a positive integer',
    );
    assertNonNegativeInteger(
      input.targetSeq,
      'replay input targetSeq must be a non-negative integer',
    );
    invariant(
      input.targetSeq >= this.lastAppliedSeq,
      'stateful GhosttyWebBackend cannot rewind from seq ' +
        String(this.lastAppliedSeq) +
        ' to ' +
        String(input.targetSeq),
    );

    const maxGapMs = options.maxGapMs;
    const minFrameHoldMs = options.minFrameHoldMs;
    const finalFrameHoldMs = options.finalFrameHoldMs;
    assertNonNegativeInteger(
      maxGapMs,
      'replayWithTiming maxGapMs must be a non-negative integer',
    );
    assertNonNegativeInteger(
      minFrameHoldMs,
      'replayWithTiming minFrameHoldMs must be a non-negative integer',
    );
    assertNonNegativeInteger(
      finalFrameHoldMs,
      'replayWithTiming finalFrameHoldMs must be a non-negative integer',
    );

    const waitForDelay = async (delayMs: number): Promise<void> => {
      assertNonNegativeInteger(
        delayMs,
        'replayWithTiming delayMs must be a non-negative integer',
      );
      if (delayMs === 0) {
        return;
      }

      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, delayMs);
      });
    };
    const parseEventTimestampMs = (
      eventTs: string,
      eventSeq: number,
    ): number => {
      assertString(
        eventTs,
        `replay event ${String(eventSeq)} ts must be an ISO timestamp string`,
      );
      const timestampMs = Date.parse(eventTs);
      invariant(
        Number.isFinite(timestampMs),
        `replay event ${String(eventSeq)} ts must be a valid ISO timestamp`,
      );
      return timestampMs;
    };

    if (this.initialReplayCols === null || this.initialReplayRows === null) {
      await this.resizeBridge(page, input.initialCols, input.initialRows);
      this.initialReplayCols = input.initialCols;
      this.initialReplayRows = input.initialRows;
      this.currentCols = input.initialCols;
      this.currentRows = input.initialRows;
      await waitForDelay(minFrameHoldMs);
    } else {
      invariant(
        this.initialReplayCols === input.initialCols &&
          this.initialReplayRows === input.initialRows,
        'replay input initial dimensions changed after the first replay',
      );
    }

    let outputEventCount = 0;
    let previousEventSeq = -1;
    let previousProcessedEventTimestampMs: number | null = null;
    let processedEventCount = 0;
    let resizeEventCount = 0;
    let highestProcessedSeq = this.lastAppliedSeq;
    let pendingOutputChunks: string[] = [];

    const flushOutputBatch = async (): Promise<void> => {
      if (pendingOutputChunks.length === 0) {
        return;
      }

      await this.flushOutputBatch(page, pendingOutputChunks);
      pendingOutputChunks = [];
      await waitForDelay(minFrameHoldMs);
    };

    for (const event of input.events) {
      assertNonNegativeInteger(
        event.seq,
        'replay event seq must be a non-negative integer',
      );
      invariant(
        event.seq > previousEventSeq,
        'replay events must be ordered by strictly increasing seq values',
      );
      previousEventSeq = event.seq;

      if (event.seq <= this.lastAppliedSeq) {
        continue;
      }

      if (event.seq > input.targetSeq) {
        await flushOutputBatch();
        break;
      }

      const eventTimestampMs = parseEventTimestampMs(event.ts, event.seq);
      if (previousProcessedEventTimestampMs !== null) {
        const interEventDelayMs =
          eventTimestampMs - previousProcessedEventTimestampMs;
        invariant(
          interEventDelayMs >= 0,
          'replay event timestamps must be ordered non-decreasingly',
        );
        await waitForDelay(Math.min(interEventDelayMs, maxGapMs));
      }
      previousProcessedEventTimestampMs = eventTimestampMs;

      switch (event.type) {
        case 'output': {
          pendingOutputChunks.push(event.payload.data);
          outputEventCount += 1;
          break;
        }
        case 'resize': {
          await flushOutputBatch();
          assertPositiveInteger(
            event.payload.cols,
            'resize event cols must be a positive integer',
          );
          assertPositiveInteger(
            event.payload.rows,
            'resize event rows must be a positive integer',
          );
          await this.resizeBridge(page, event.payload.cols, event.payload.rows);
          this.currentCols = event.payload.cols;
          this.currentRows = event.payload.rows;
          resizeEventCount += 1;
          await waitForDelay(minFrameHoldMs);
          break;
        }
        case 'marker': {
          await flushOutputBatch();
          break;
        }
        case 'input_text':
        case 'input_paste':
        case 'input_keys':
        case 'signal':
        case 'exit': {
          await flushOutputBatch();
          break;
        }
        default: {
          unreachable(event, 'unsupported replay event type');
        }
      }

      processedEventCount += 1;
      highestProcessedSeq = event.seq;
    }

    await flushOutputBatch();

    invariant(
      outputEventCount + resizeEventCount <= processedEventCount,
      'visual event count must not exceed processed event count',
    );

    if (highestProcessedSeq !== this.lastAppliedSeq) {
      await waitForDelay(finalFrameHoldMs);
    }

    if (highestProcessedSeq < 0) {
      highestProcessedSeq = input.targetSeq;
    }

    this.lastAppliedSeq = highestProcessedSeq;

    const snapshot = await this.readHarnessSnapshot(page);
    this.currentCols = snapshot.cols;
    this.currentRows = snapshot.rows;

    return {
      lastSeq: this.lastAppliedSeq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursorRow: snapshot.cursorRow,
      cursorCol: snapshot.cursorCol,
    };
  }

  public async snapshot(options?: SnapshotOptions): Promise<SemanticSnapshot> {
    const page = this.requireOperationalPage('snapshot()');
    invariant(
      this.lastAppliedSeq >= 0,
      'snapshot() requires replayTo() to advance to a non-negative sequence first',
    );

    const snapshot = await this.readHarnessSnapshot(page, options);
    this.currentCols = snapshot.cols;
    this.currentRows = snapshot.rows;

    return {
      sessionId: this.sessionId,
      capturedAtSeq: this.lastAppliedSeq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursorRow: snapshot.cursorRow,
      cursorCol: snapshot.cursorCol,
      isAltScreen: snapshot.isAltScreen,
      visibleLines: snapshot.visibleLines,
      ...(snapshot.scrollbackLines !== undefined && {
        scrollbackLines: snapshot.scrollbackLines,
      }),
    };
  }

  public async screenshot(outputPath: string): Promise<ScreenshotResult> {
    const page = this.requireOperationalPage('screenshot()');
    invariant(
      this.lastAppliedSeq >= 0,
      'screenshot() requires replayTo() to advance to a non-negative sequence first',
    );
    invariant(
      outputPath.length > 0,
      'screenshot outputPath must be a non-empty string',
    );
    invariant(
      isAbsolute(outputPath),
      'screenshot outputPath must be an absolute path',
    );

    const outputDirectory = dirname(outputPath);
    const outputDirectoryStat = await stat(outputDirectory);
    invariant(
      outputDirectoryStat.isDirectory(),
      'screenshot output directory must exist',
    );
    invariant(
      this.currentCols !== null && this.currentRows !== null,
      'screenshot() requires known terminal dimensions',
    );

    await this.waitForScreenshotPaint(page);

    await page.locator('#terminal').screenshot({
      animations: 'disabled',
      caret: 'hide',
      path: outputPath,
      type: 'png',
    });

    const screenshotFile = await stat(outputPath);
    assertPositiveInteger(
      screenshotFile.size,
      'screenshot output PNG must be non-empty',
    );

    const pngBuffer = await readFile(outputPath);
    const PNG_SIGNATURE = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    invariant(pngBuffer.length >= 24, 'screenshot PNG must contain IHDR bytes');
    invariant(
      pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE),
      'screenshot output must be a PNG',
    );
    invariant(
      pngBuffer.subarray(12, 16).toString('ascii') === 'IHDR',
      'first PNG chunk must be IHDR',
    );

    const pixelWidth = pngBuffer.readUInt32BE(16);
    const pixelHeight = pngBuffer.readUInt32BE(20);
    invariant(
      pixelWidth > 0 && pixelHeight > 0,
      `invalid PNG dimensions: ${String(pixelWidth)}x${String(pixelHeight)}`,
    );

    const sha256 = createHash('sha256').update(pngBuffer).digest('hex');

    return {
      sessionId: this.sessionId,
      capturedAtSeq: this.lastAppliedSeq,
      profileName: this.profile.name,
      cols: this.currentCols,
      rows: this.currentRows,
      artifactPath: outputPath,
      pngSizeBytes: screenshotFile.size,
      rendererBackend: this.rendererBackend,
      pixelWidth,
      pixelHeight,
      sha256,
      renderProfileHash: hashProfile(this.profile),
    };
  }

  public async finalizeVideo(outputPath: string): Promise<void> {
    invariant(
      this.videoOptions !== null,
      'finalizeVideo() requires video recording to be enabled',
    );
    invariant(
      outputPath.length > 0,
      'video outputPath must be a non-empty string',
    );
    invariant(
      isAbsolute(outputPath),
      'finalizeVideo() outputPath must be an absolute path',
    );
    invariant(
      outputPath.endsWith('.webm'),
      'finalizeVideo() outputPath must end with .webm',
    );

    const outputDirectory = dirname(outputPath);
    const outputDirectoryStat = await stat(outputDirectory);
    invariant(
      outputDirectoryStat.isDirectory(),
      'finalizeVideo() output directory must exist',
    );

    const page = this.requireOperationalPage('finalizeVideo()');
    const browserContext = this.browserContext;
    invariant(
      browserContext !== null,
      'finalizeVideo() requires an active Playwright browser context',
    );

    const video = page.video();
    invariant(
      video !== null,
      'finalizeVideo() requires an active Playwright video',
    );

    this.expectedPageClosure = true;
    try {
      await page.close();
      await browserContext.close();
    } finally {
      this.expectedPageClosure = false;
    }

    await video.saveAs(outputPath);
    this.page = null;
    this.browserContext = null;

    const outputFile = await stat(outputPath);
    invariant(outputFile.isFile(), 'finalizeVideo() output must be a file');
    assertPositiveInteger(
      outputFile.size,
      'finalizeVideo() output video must be non-empty',
    );
  }

  public async getVisibleText(): Promise<string> {
    const page = this.requireOperationalPage('getVisibleText()');

    const visibleText = await page.evaluate(() => {
      const bridge = (globalThis as GhosttyBrowserGlobal).__agentTerminal;
      if (bridge === undefined || typeof bridge.getVisibleText !== 'function') {
        throw new Error('ghostty-web bridge getVisibleText() is unavailable');
      }

      return bridge.getVisibleText();
    });

    assertString(visibleText, 'ghostty-web visible text must be a string');
    return visibleText;
  }

  public async dispose(): Promise<void> {
    if (this.disposePromise !== null) {
      await this.disposePromise;
      return;
    }

    this.disposePromise = this.disposeInternal();
    await this.disposePromise;
  }

  private async bootInternal(): Promise<void> {
    try {
      const servedAssets = await getServedAssets();
      const { origin, server } = await this.startServer(servedAssets);
      this.server = server;
      this.serverOrigin = origin;

      this.browser = await chromium.launch({
        headless: true,
      });
      this.browser.on('disconnected', () => {
        this.recordUnexpectedFailure(
          new Error('ghostty-web browser disconnected unexpectedly'),
        );
      });

      this.browserContext = await this.browser.newContext({
        deviceScaleFactor: 1,
        viewport: this.videoOptions?.size
          ? {
              width: this.videoOptions.size.width,
              height: this.videoOptions.size.height,
            }
          : DEFAULT_PAGE_VIEWPORT,
        ...(this.videoOptions
          ? {
              recordVideo: {
                dir: this.videoOptions.outputDir,
                size: this.videoOptions.size,
              },
            }
          : {}),
      });
      await this.browserContext.route('**/*', async (route) => {
        if (this.isAllowedBrowserRequest(route.request().url())) {
          await route.continue();
          return;
        }

        await route.abort('blockedbyclient');
      });

      this.page = await this.browserContext.newPage();
      this.page.on('close', () => {
        if (this.disposePromise !== null || this.expectedPageClosure) {
          return;
        }

        this.recordUnexpectedFailure(
          new Error('ghostty-web page closed unexpectedly'),
        );
      });
      this.page.on('crash', () => {
        this.recordUnexpectedFailure(new Error('ghostty-web page crashed'));
      });
      this.page.on('pageerror', (error) => {
        this.recordUnexpectedFailure(
          normalizeError(error, 'ghostty-web page error'),
        );
      });

      await this.page.goto(this.buildHarnessUrl(origin), {
        waitUntil: 'domcontentloaded',
      });
      await this.page.waitForFunction(
        () => {
          const bridge = (globalThis as GhosttyBrowserGlobal).__agentTerminal;
          return (
            bridge !== undefined &&
            typeof bridge.isReady === 'function' &&
            bridge.isReady()
          );
        },
        undefined,
        { timeout: 30_000 },
      );

      const bridgeReady = await this.page.evaluate(() => {
        const bridge = (globalThis as GhosttyBrowserGlobal).__agentTerminal;
        return (
          bridge !== undefined &&
          typeof bridge.isReady === 'function' &&
          bridge.isReady()
        );
      });
      invariant(bridgeReady, 'ghostty-web harness did not report ready');
      this.isBooted = true;
    } catch (error) {
      const page = this.page;
      const pageError =
        page === null ? null : await this.readHarnessErrorMessage(page);
      const bootError = normalizeError(
        pageError === null ? error : new Error(pageError),
        'failed to boot GhosttyWebBackend',
      );
      this.failureReason = bootError;
      await this.cleanupHandles();
      this.bootPromise = null;
      throw bootError;
    }
  }

  private buildHarnessUrl(origin: string): string {
    const searchParams = new URLSearchParams({
      profile: JSON.stringify(this.profile),
    });
    return `${origin}/harness.html?${searchParams.toString()}`;
  }

  private async cleanupHandles(): Promise<void> {
    const page = this.page;
    const browserContext = this.browserContext;
    const browser = this.browser;
    const server = this.server;

    this.page = null;
    this.browserContext = null;
    this.browser = null;
    this.server = null;
    this.serverOrigin = null;
    this.isBooted = false;

    if (page !== null) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch {
        // Keep unwinding remaining resources even if a close operation fails.
      }
    }

    if (browserContext !== null) {
      try {
        await browserContext.close();
      } catch {
        // Keep unwinding remaining resources even if a close operation fails.
      }
    }

    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        // Keep unwinding remaining resources even if a close operation fails.
      }
    }

    if (server !== null) {
      try {
        await closeServer(server);
      } catch {
        // Keep unwinding remaining resources even if a close operation fails.
      }
    }
  }

  private async disposeInternal(): Promise<void> {
    try {
      await this.cleanupHandles();
    } finally {
      this.bootPromise = null;
      this.currentCols = null;
      this.currentRows = null;
      this.disposePromise = null;
      this.failureReason = null;
      this.initialReplayCols = null;
      this.initialReplayRows = null;
      this.isBooted = false;
      this.lastAppliedSeq = -1;
    }
  }

  private isAllowedBrowserRequest(requestUrl: string): boolean {
    const serverOrigin = this.serverOrigin;
    if (serverOrigin === null) {
      return false;
    }

    const parsedUrl = new URL(requestUrl);
    if (parsedUrl.protocol === 'data:' || parsedUrl.protocol === 'blob:') {
      return true;
    }

    return parsedUrl.origin === serverOrigin;
  }

  private async readHarnessErrorMessage(page: Page): Promise<string | null> {
    try {
      const harnessError = await page.evaluate(() => {
        const bodyDataset = (globalThis as GhosttyBrowserGlobal).document?.body
          ?.dataset;
        const errorMessage = bodyDataset?.error;
        return typeof errorMessage === 'string' && errorMessage.length > 0
          ? errorMessage
          : null;
      });

      return harnessError;
    } catch {
      return null;
    }
  }

  private async readHarnessSnapshot(
    page: Page,
    options?: SnapshotOptions,
  ): Promise<GhosttyHarnessSnapshot> {
    const snapshot = await page.evaluate(
      (opts) => {
        const bridge = (globalThis as GhosttyBrowserGlobal).__agentTerminal;
        if (bridge === undefined || typeof bridge.getSnapshot !== 'function') {
          throw new Error('ghostty-web bridge getSnapshot() is unavailable');
        }

        return bridge.getSnapshot(opts);
      },
      options === undefined
        ? undefined
        : options.includeScrollback === undefined
          ? {}
          : { includeScrollback: options.includeScrollback },
    );

    const validatedSnapshot = validateHarnessSnapshot(snapshot);
    invariant(
      validatedSnapshot.visibleLines.length <= validatedSnapshot.rows,
      'snapshot visible line count must not exceed the viewport rows',
    );
    invariant(
      validatedSnapshot.cursorRow < validatedSnapshot.rows,
      'snapshot cursorRow must be within the viewport height',
    );
    invariant(
      validatedSnapshot.cursorCol < validatedSnapshot.cols,
      'snapshot cursorCol must be within the viewport width',
    );

    return validatedSnapshot;
  }

  private recordUnexpectedFailure(error: Error): void {
    if (this.disposePromise !== null) {
      return;
    }

    this.failureReason = error;
    this.isBooted = false;
    this.bootPromise = null;
  }

  private requireOperationalPage(methodName: string): Page {
    if (this.failureReason !== null) {
      invariant(
        false,
        `${methodName} cannot continue after renderer failure: ${this.failureReason.message}`,
      );
    }

    invariant(
      this.isBooted,
      `${methodName} requires a booted GhosttyWebBackend`,
    );
    invariant(
      this.page !== null,
      `${methodName} requires an active Playwright page`,
    );
    invariant(
      !this.page.isClosed(),
      `${methodName} requires an open Playwright page`,
    );

    return this.page;
  }

  private async resizeBridge(
    page: Page,
    cols: number,
    rows: number,
  ): Promise<void> {
    assertPositiveInteger(
      cols,
      'bridge resize cols must be a positive integer',
    );
    assertPositiveInteger(
      rows,
      'bridge resize rows must be a positive integer',
    );

    await page.evaluate(
      async ([nextCols, nextRows]) => {
        const bridge = (globalThis as GhosttyBrowserGlobal).__agentTerminal;
        if (bridge === undefined || typeof bridge.resize !== 'function') {
          throw new Error('ghostty-web bridge resize() is unavailable');
        }

        await bridge.resize(nextCols, nextRows);
      },
      [cols, rows] as const,
    );
  }

  private async waitForScreenshotPaint(page: Page): Promise<void> {
    await Promise.race([
      page.evaluate(() => {
        const requestNextFrame = (
          globalThis as unknown as {
            requestAnimationFrame: (callback: () => void) => number;
          }
        ).requestAnimationFrame;
        return new Promise<void>((resolve) => {
          requestNextFrame(() => {
            requestNextFrame(() => {
              resolve();
            });
          });
        });
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Screenshot paint wait timed out after 5s'));
        }, RAF_TIMEOUT_MS);
      }),
    ]);
  }

  private async flushOutputBatch(
    page: Page,
    dataChunks: string[],
  ): Promise<void> {
    invariant(
      dataChunks.length > 0,
      'flushOutputBatch requires at least one data chunk',
    );

    for (
      let batchStart = 0;
      batchStart < dataChunks.length;
      batchStart += MAX_REPLAY_BATCH_SIZE
    ) {
      const batch = dataChunks.slice(
        batchStart,
        batchStart + MAX_REPLAY_BATCH_SIZE,
      );
      invariant(batch.length > 0, 'flushOutputBatch batch must not be empty');
      invariant(
        batch.length <= MAX_REPLAY_BATCH_SIZE,
        'flushOutputBatch batch size must respect MAX_REPLAY_BATCH_SIZE',
      );
      await this.writeBatchBridge(page, batch);
    }
  }

  private async startServer(
    servedAssets: ReadonlyMap<string, GhosttyServedAsset>,
  ): Promise<{
    origin: string;
    server: Server;
  }> {
    const server = createServer((request, response) => {
      this.respondToRequest(servedAssets, request, response);
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectPromise);
        resolvePromise();
      });
    });

    const address = server.address();
    invariant(
      address !== null && typeof address === 'object',
      'ghostty-web server must expose a TCP address',
    );
    assertPositiveInteger(
      address.port,
      'ghostty-web server port must be positive',
    );

    return {
      origin: 'http://127.0.0.1:' + String(address.port),
      server,
    };
  }

  private respondToRequest(
    servedAssets: ReadonlyMap<string, GhosttyServedAsset>,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const requestMethod = request.method ?? 'GET';
    if (requestMethod !== 'GET' && requestMethod !== 'HEAD') {
      response.writeHead(405, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Method Not Allowed');
      return;
    }

    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const asset = servedAssets.get(requestUrl.pathname);
    if (asset === undefined) {
      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Not Found');
      return;
    }

    const headers: Record<string, number | string> = {
      'cache-control': 'no-store',
      'content-length': asset.body.byteLength,
      'content-type': asset.contentType,
      'x-content-type-options': 'nosniff',
    };
    if (asset.contentSecurityPolicy !== undefined) {
      headers['content-security-policy'] = asset.contentSecurityPolicy;
    }

    response.writeHead(200, headers);
    if (requestMethod === 'HEAD') {
      response.end();
      return;
    }

    response.end(asset.body);
  }

  private async writeBatchBridge(
    page: Page,
    dataChunks: string[],
  ): Promise<void> {
    invariant(
      dataChunks.length > 0,
      'writeBatchBridge requires at least one data chunk',
    );
    invariant(
      dataChunks.length <= MAX_REPLAY_BATCH_SIZE,
      'writeBatchBridge batch size must not exceed MAX_REPLAY_BATCH_SIZE',
    );
    for (const chunk of dataChunks) {
      assertString(chunk, 'bridge batch write chunk must be a string');
    }

    await page.evaluate(async (chunks: string[]) => {
      const bridge = (globalThis as GhosttyBrowserGlobal).__agentTerminal;
      if (bridge === undefined || typeof bridge.write !== 'function') {
        throw new Error('ghostty-web bridge write() is unavailable');
      }

      for (const chunk of chunks) {
        await bridge.write(chunk);
      }
    }, dataChunks);
  }

  private async writeBridge(page: Page, data: string): Promise<void> {
    assertString(data, 'bridge write data must be a string');

    await page.evaluate(async (nextData) => {
      const bridge = (globalThis as GhosttyBrowserGlobal).__agentTerminal;
      if (bridge === undefined || typeof bridge.write !== 'function') {
        throw new Error('ghostty-web bridge write() is unavailable');
      }

      await bridge.write(nextData);
    }, data);
  }
}
