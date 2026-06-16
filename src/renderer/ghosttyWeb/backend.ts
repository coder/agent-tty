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

import { ensurePlaywrightBrowsersPath } from '../browserPath.js';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';

import { invariant, assertString, unreachable } from '../../util/assert.js';
import {
  Logger,
  assertLogLevel,
  createProcessLogger,
  type LogLevel,
} from '../../util/logger.js';
import {
  ResourceScope,
  ResourceScopeCloseError,
} from '../../util/resourceScope.js';
import type {
  ReplayTimingOptions,
  ScreenshotOptions,
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
import { BUNDLED_FONT_ASSETS } from '../bundledFont.js';
import { hashProfile } from '../profiles.js';
import { iterateInRangeReplayEvents } from '../replayEvents.js';
import {
  assertHexColor,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertPositiveNumber,
  loadHarnessHtml,
  normalizeError,
  validateHarnessSnapshot,
} from './harnessDecoding.js';
import type { GhosttyHarnessSnapshot } from './harnessDecoding.js';

export {
  assembleCanonicalLine,
  stripTrailingAsciiSpaces,
} from './harnessDecoding.js';
export type { GhosttyDecodedColumn } from './harnessDecoding.js';

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
  setCursorVisible?: (visible: boolean) => Promise<void> | void;
  getSnapshot?: (options?: SnapshotOptions) => GhosttyHarnessSnapshot;
  getVisibleText?: () => string;
}

interface GhosttyBrowserGlobal {
  __agentTty?: GhosttyBrowserBridge;
  __agentTtyLog?: (
    level: LogLevel,
    message: string,
    detail?: string,
  ) => Promise<void> | void;
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

let servedAssetsPromise: Promise<
  ReadonlyMap<string, GhosttyServedAsset>
> | null = null;

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

  const harnessHtml = loadHarnessHtml();
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

  for (const bundledFontAsset of BUNDLED_FONT_ASSETS) {
    invariant(
      bundledFontAsset.buffer.byteLength > 0,
      `bundled font asset ${bundledFontAsset.route} must not be empty`,
    );
    assetEntries.set(bundledFontAsset.route, {
      body: bundledFontAsset.buffer,
      contentType: bundledFontAsset.contentType,
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

export class GhosttyWebBackend implements VideoCapableRendererBackend {
  public readonly rendererBackend = 'ghostty-web';
  public isBooted = false;

  private readonly logger: Logger;
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
  // True once finalizeVideo() has manually closed page + browserContext.
  // Release closures in the per-lifecycle ResourceScope check this flag so
  // dispose() does not call .close() a second time on those externally
  // closed handles. Reset at the start of every bootInternal() and on
  // disposeInternal() state nulling.
  private pageAndContextReleasedExternally = false;
  // Memoizes which scopes have already had their failures logged. Prevents
  // duplicate warnings if both bootInternal()'s catch and a concurrent
  // dispose() race on the same scope.
  private readonly loggedScopes = new WeakSet<ResourceScope>();
  private initialReplayCols: number | null = null;
  private initialReplayRows: number | null = null;
  private lastAppliedSeq = -1;
  private page: Page | null = null;
  // Per-lifecycle scope: a fresh ResourceScope is created at the start of every
  // bootInternal() and closed during boot-failure rollback or dispose(). This
  // matches the existing contract of supporting a second boot() after dispose()
  // (see test/integration/renderer-backend.test.ts).
  private resourceScope: ResourceScope | null = null;
  private server: Server | null = null;
  private serverOrigin: string | null = null;

  public constructor(
    sessionId: string,
    profile: RenderProfileConfig,
    videoOptions?: VideoRecordingOptions,
    // The default logger reads AGENT_TTY_LOG_LEVEL from process.env at
    // construction time. In CLI flows, main.ts sets this env var in preAction
    // before any command handler runs, so the effective level is correct.
    // Callers may pass an explicit Logger for testing or non-CLI contexts.
    logger: Logger = createProcessLogger(),
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

    invariant(logger instanceof Logger, 'logger must be a Logger instance');

    this.sessionId = sessionId;
    this.logger = logger;
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

    let highestProcessedSeq = this.lastAppliedSeq;
    let pendingOutputChunks: string[] = [];

    const flushOutputBatch = async (): Promise<void> => {
      if (pendingOutputChunks.length === 0) {
        return;
      }

      await this.flushOutputBatch(page, pendingOutputChunks);
      pendingOutputChunks = [];
    };

    for (const event of iterateInRangeReplayEvents(
      input,
      this.lastAppliedSeq,
    )) {
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
        case 'input_run':
        case 'run_complete':
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
    timing: ReplayTimingOptions,
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
    const timingValue: unknown = timing;
    invariant(
      typeof timingValue === 'object' && timingValue !== null,
      'replayWithTiming timing must be an object',
    );
    assertString(
      (timingValue as { mode?: unknown }).mode,
      'replayWithTiming timing.mode must be a string',
    );

    let resolvedMinFrameHoldMs: number;
    let finalFrameHoldMs: number;
    switch (timing.mode) {
      case 'accelerated': {
        assertNonNegativeInteger(
          timing.maxGapMs,
          'replayWithTiming maxGapMs must be a non-negative integer',
        );
        assertNonNegativeInteger(
          timing.minFrameHoldMs,
          'replayWithTiming minFrameHoldMs must be a non-negative integer',
        );
        assertNonNegativeInteger(
          timing.finalFrameHoldMs,
          'replayWithTiming finalFrameHoldMs must be a non-negative integer',
        );
        resolvedMinFrameHoldMs = timing.minFrameHoldMs;
        finalFrameHoldMs = timing.finalFrameHoldMs;
        break;
      }
      case 'recorded': {
        assertNonNegativeInteger(
          timing.finalFrameHoldMs,
          'replayWithTiming finalFrameHoldMs must be a non-negative integer',
        );
        resolvedMinFrameHoldMs = 16;
        finalFrameHoldMs = timing.finalFrameHoldMs;
        break;
      }
      case 'max-speed': {
        assertNonNegativeInteger(
          timing.minFrameHoldMs,
          'replayWithTiming minFrameHoldMs must be a non-negative integer',
        );
        assertNonNegativeInteger(
          timing.finalFrameHoldMs,
          'replayWithTiming finalFrameHoldMs must be a non-negative integer',
        );
        resolvedMinFrameHoldMs = timing.minFrameHoldMs;
        finalFrameHoldMs = timing.finalFrameHoldMs;
        break;
      }
      default: {
        unreachable(timing, 'unsupported replay timing mode');
      }
    }

    const computeInterEventDelay = (interEventDelayMs: number): number => {
      switch (timing.mode) {
        case 'accelerated':
          return Math.min(interEventDelayMs, timing.maxGapMs);
        case 'recorded':
          return interEventDelayMs;
        case 'max-speed':
          return 0;
        default:
          return unreachable(timing, 'unsupported replay timing mode');
      }
    };

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
      await waitForDelay(resolvedMinFrameHoldMs);
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
      await waitForDelay(resolvedMinFrameHoldMs);
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
        await waitForDelay(computeInterEventDelay(interEventDelayMs));
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
          await waitForDelay(resolvedMinFrameHoldMs);
          break;
        }
        case 'marker': {
          await flushOutputBatch();
          break;
        }
        case 'input_text':
        case 'input_paste':
        case 'input_keys':
        case 'input_run':
        case 'run_complete':
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
      ...(snapshot.cells !== undefined && {
        cells: snapshot.cells,
      }),
    };
  }

  public async screenshot(
    outputPath: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult> {
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
      options === undefined || typeof options === 'object',
      'screenshot options must be an object when provided',
    );
    invariant(
      options?.showCursor === undefined ||
        typeof options.showCursor === 'boolean',
      'screenshot showCursor option must be a boolean when provided',
    );

    const showCursor = options?.showCursor === true;

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

    await this.setScreenshotCursorVisibility(page, showCursor);
    await this.waitForScreenshotPaint(page);

    await page.locator('#terminal').screenshot({
      animations: 'disabled',
      caret: showCursor ? 'initial' : 'hide',
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
      cursorVisible: showCursor,
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
      // DEREM-6: tell the per-lifecycle ResourceScope's release closures
      // that page + browserContext are already released, so dispose() does
      // not call .close() a second time on these handles.
      this.pageAndContextReleasedExternally = true;
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
      const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
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

    // Symmetric with boot()'s wait on disposePromise: avoid racing with an
    // in-flight bootInternal() so cleanup does not try to close partially
    // acquired resources mid-acquisition. Boot-failure rollback owns its
    // own scope close; we swallow its rejection here.
    this.disposePromise = this.disposeAfterBoot();
    try {
      await this.disposePromise;
    } finally {
      // DEREM-4: clear here, not inside disposeInternal()'s finally. When
      // disposeInternal runs synchronously (no scope to close), its finally
      // would otherwise execute before the outer assignment lands and leave
      // a stale resolved Promise pinned on this.disposePromise.
      this.disposePromise = null;
    }
  }

  private async disposeAfterBoot(): Promise<void> {
    if (this.bootPromise !== null) {
      try {
        await this.bootPromise;
      } catch {
        // Boot-failure rollback already cleaned up. Ignore.
      }
    }
    await this.disposeInternal();
  }

  private async bootInternal(): Promise<void> {
    // Fresh per-lifecycle scope; reset the externally-released flag so a
    // re-boot after a video-finalized session uses unguarded releases.
    this.pageAndContextReleasedExternally = false;
    const scope = new ResourceScope();
    this.resourceScope = scope;

    try {
      const servedAssets = await getServedAssets();
      const { origin, server } = await this.startServer(servedAssets);
      this.server = server;
      this.serverOrigin = origin;
      scope.add('server', () => closeServer(server));

      // Set PLAYWRIGHT_BROWSERS_PATH in process.env so downstream Playwright calls
      // find the browser cache even when HOME has been changed for isolation.
      const browserPathResolution = ensurePlaywrightBrowsersPath();
      if (browserPathResolution === null) {
        this.logger.debug(
          'No Playwright browser cache override resolved; using Playwright defaults',
        );
      } else {
        this.logger.debug(
          'Resolved Playwright browser cache path',
          browserPathResolution,
        );
      }

      const browser = await chromium.launch({
        headless: true,
      });
      this.browser = browser;
      scope.add('browser', () => browser.close());
      browser.on('disconnected', () => {
        this.recordUnexpectedFailure(
          new Error('ghostty-web browser disconnected unexpectedly'),
        );
      });

      const browserContext = await browser.newContext({
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
      this.browserContext = browserContext;
      scope.add('browserContext', async () => {
        // DEREM-6: finalizeVideo() closes the browser context manually as
        // part of saving the video. BrowserContext lacks an isClosed()
        // probe, so rely on a backend flag to skip the second close.
        if (this.pageAndContextReleasedExternally) {
          return;
        }
        await browserContext.close();
      });
      await browserContext.route('**/*', async (route) => {
        if (this.isAllowedBrowserRequest(route.request().url())) {
          await route.continue();
          return;
        }

        await route.abort('blockedbyclient');
      });

      const page = await browserContext.newPage();
      this.page = page;
      scope.add('page', async () => {
        // DEREM-6: when finalizeVideo() has already closed the page, skip
        // the redundant close. The isClosed() probe still guards the
        // common dispose-only path.
        if (this.pageAndContextReleasedExternally) {
          return;
        }
        if (!page.isClosed()) {
          await page.close();
        }
      });
      await page.exposeFunction(
        '__agentTtyLog',
        (level: unknown, message: unknown, detail?: unknown) => {
          assertLogLevel(level, 'ghostty-web harness log level must be valid');
          assertString(
            message,
            'ghostty-web harness log message must be a string',
          );
          const details = detail === undefined ? [] : [detail];

          switch (level) {
            case 'debug': {
              this.logger.debug(message, ...details);
              break;
            }
            case 'info': {
              this.logger.info(message, ...details);
              break;
            }
            case 'warn': {
              this.logger.warn(message, ...details);
              break;
            }
            case 'error': {
              this.logger.error(message, ...details);
              break;
            }
            default: {
              unreachable(level, 'unsupported harness log level');
            }
          }
        },
      );
      page.on('close', () => {
        if (this.disposePromise !== null || this.expectedPageClosure) {
          return;
        }

        this.recordUnexpectedFailure(
          new Error('ghostty-web page closed unexpectedly'),
        );
      });
      page.on('crash', () => {
        this.recordUnexpectedFailure(new Error('ghostty-web page crashed'));
      });
      page.on('pageerror', (error) => {
        this.recordUnexpectedFailure(
          normalizeError(error, 'ghostty-web page error'),
        );
      });

      await page.goto(this.buildHarnessUrl(origin), {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForFunction(
        () => {
          const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
          return (
            bridge !== undefined &&
            typeof bridge.isReady === 'function' &&
            bridge.isReady()
          );
        },
        undefined,
        { timeout: 30_000 },
      );

      const bridgeReady = await page.evaluate(() => {
        const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
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
      // DEREM-3: null state and clear isBooted synchronously BEFORE
      // awaiting scope close. Release closures captured local resource
      // variables, so they are unaffected. Any concurrent operation that
      // checks requireOperationalPage() now fails immediately on a clear
      // invariant rather than acting on a tearing-down resource.
      this.resourceScope = null;
      this.page = null;
      this.browserContext = null;
      this.browser = null;
      this.server = null;
      this.serverOrigin = null;
      this.isBooted = false;
      this.failureReason = bootError;
      await this.closeResourceScopeAndLog(scope);
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

  private async closeResourceScopeAndLog(scope: ResourceScope): Promise<void> {
    try {
      await scope.close();
    } catch (error) {
      // DEREM-8: skip duplicate logging if another caller already drained
      // and logged this scope's failures (e.g., bootInternal()'s catch
      // racing with a concurrent dispose() on the same scope reference).
      if (this.loggedScopes.has(scope)) {
        return;
      }
      this.loggedScopes.add(scope);

      // DEREM-7: ADR 0003 promises dispose() resolves successfully even on
      // cleanup failure. Wrap each logger.warn so a broken stderr (EPIPE
      // during process shutdown) cannot reject this method and propagate
      // through dispose().
      if (error instanceof ResourceScopeCloseError) {
        for (const failure of error.failures) {
          // DEREM-2: pass the failure error directly so formatLogDetail
          // hits its `instanceof Error` branch instead of stringifying an
          // Error wrapper into `{}`.
          this.safeWarn(
            `ghostty-web renderer cleanup failure: ${failure.name}`,
            failure.error,
          );
        }
        return;
      }
      // Defensive: scope.close() should only ever reject with
      // ResourceScopeCloseError, but log defensively if not.
      this.safeWarn(
        'ghostty-web renderer cleanup unexpected error during scope close',
        error,
      );
    }
  }

  private safeWarn(message: string, detail: unknown): void {
    try {
      this.logger.warn(message, detail);
    } catch {
      // Logging through stderr can throw EPIPE during shutdown. Swallow
      // so dispose() honors its best-effort contract (ADR 0003).
    }
  }

  private async disposeInternal(): Promise<void> {
    // DEREM-3: capture the scope reference and null state synchronously
    // BEFORE awaiting scope close. Release closures captured locals at
    // registration time, so they are unaffected. Concurrent operations
    // that check requireOperationalPage() see isBooted=false / page=null
    // immediately rather than racing with a tearing-down resource.
    const scope = this.resourceScope;
    this.resourceScope = null;
    this.page = null;
    this.browserContext = null;
    this.browser = null;
    this.server = null;
    this.serverOrigin = null;
    this.isBooted = false;

    try {
      if (scope !== null) {
        await this.closeResourceScopeAndLog(scope);
      }
    } finally {
      this.bootPromise = null;
      this.currentCols = null;
      this.currentRows = null;
      // DEREM-4: disposePromise is reset by dispose() after this awaits,
      // not here. Resetting here would race with the outer assignment in
      // dispose() when this method runs synchronously (no scope to
      // close), pinning a stale resolved Promise.
      this.failureReason = null;
      this.initialReplayCols = null;
      this.initialReplayRows = null;
      this.lastAppliedSeq = -1;
      this.pageAndContextReleasedExternally = false;
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
    const bridgeOptions: SnapshotOptions = {};
    if (options?.includeScrollback !== undefined) {
      bridgeOptions.includeScrollback = options.includeScrollback;
    }
    if (options?.includeCells !== undefined) {
      bridgeOptions.includeCells = options.includeCells;
    }

    const snapshot = await page.evaluate(
      (opts) => {
        const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
        if (bridge === undefined || typeof bridge.getSnapshot !== 'function') {
          throw new Error('ghostty-web bridge getSnapshot() is unavailable');
        }

        return bridge.getSnapshot(opts);
      },
      Object.keys(bridgeOptions).length === 0 ? undefined : bridgeOptions,
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
    if (validatedSnapshot.cells !== undefined) {
      invariant(
        validatedSnapshot.cells.length ===
          validatedSnapshot.visibleLines.length,
        'snapshot cell line count must match visible line count after validation',
      );
      for (const richLine of validatedSnapshot.cells) {
        invariant(
          richLine.cells.length <= validatedSnapshot.cols,
          'snapshot cell count must not exceed the viewport width',
        );
      }
    }

    return validatedSnapshot;
  }

  private recordUnexpectedFailure(error: Error): void {
    if (this.disposePromise !== null) {
      return;
    }

    // DEREM-18: only clear bootPromise once boot has fully succeeded. Doing
    // this during an in-flight boot would let a concurrent dispose() see
    // bootPromise === null in disposeAfterBoot(), skip its bootPromise
    // wait, and start tearing down the scope while bootInternal is still
    // suspended in waitForFunction. After a successful boot the promise is
    // resolved already, so clearing it lets a future boot() call re-run
    // bootInternal cleanly; bootInternal's own catch nulls it on the
    // mid-boot failure path.
    const wasBooted = this.isBooted;
    this.failureReason = error;
    this.isBooted = false;
    if (wasBooted) {
      this.bootPromise = null;
    }
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
        const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
        if (bridge === undefined || typeof bridge.resize !== 'function') {
          throw new Error('ghostty-web bridge resize() is unavailable');
        }

        await bridge.resize(nextCols, nextRows);
      },
      [cols, rows] as const,
    );
  }

  private async setScreenshotCursorVisibility(
    page: Page,
    visible: boolean,
  ): Promise<void> {
    await page.evaluate((showCursorInScreenshot: boolean) => {
      const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
      if (
        bridge === undefined ||
        typeof bridge.setCursorVisible !== 'function'
      ) {
        throw new Error(
          'ghostty-web harness setCursorVisible() bridge is unavailable',
        );
      }
      return bridge.setCursorVisible(showCursorInScreenshot);
    }, visible);
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
      const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
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
      const bridge = (globalThis as GhosttyBrowserGlobal).__agentTty;
      if (bridge === undefined || typeof bridge.write !== 'function') {
        throw new Error('ghostty-web bridge write() is unavailable');
      }

      await bridge.write(nextData);
    }, data);
  }
}
